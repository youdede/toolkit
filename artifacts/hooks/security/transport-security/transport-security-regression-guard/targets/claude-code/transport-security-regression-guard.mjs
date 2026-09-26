#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_CONTENT_BYTES = 512 * 1024;
const ALLOW = { exitCode: 0 };
const BLOCK = (ruleId, reason) => ({ exitCode: 2, ruleId, message: `BLOCKED by transport-security-regression-guard [${ruleId}]: ${reason}` });

function inside(root, target) {
  const relative = path.relative(root, target);
  return !(relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative));
}

// The nearest existing ancestor with its symbolic links resolved, plus the missing remainder.
function canonicalPath(target) {
  let cursor = target;
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(realpathSync(cursor), ...missing);
}

// Inside the project no path component may be a symbolic link. A file outside the project (another
// package when the project root is a subdirectory, /tmp) is not project configuration, but its
// proposed content is still checked; readBounded refuses a symbolic link there.
function safePath(filePath, cwd) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) throw new Error('invalid path');
  const root = realpathSync(cwd);
  let target = path.resolve(root, filePath);
  if (!inside(root, target)) {
    const canonical = canonicalPath(target);
    if (!inside(root, canonical)) return target;
    target = canonical;
  }
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('symlink path');
  }
  return target;
}

function readBounded(filePath) {
  if (!existsSync(filePath)) return '';
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.size > MAX_CONTENT_BYTES) throw new Error('uninspectable file');
  return readFileSync(filePath, 'utf8');
}

function replaceExactly(source, edit) {
  if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string' || edit.old_string.length === 0) throw new Error('invalid edit');
  const first = source.indexOf(edit.old_string);
  if (first < 0) throw new Error('old text missing');
  if (edit.replace_all === true) return source.split(edit.old_string).join(edit.new_string);
  if (source.indexOf(edit.old_string, first + edit.old_string.length) >= 0) throw new Error('ambiguous edit');
  return source.slice(0, first) + edit.new_string + source.slice(first + edit.old_string.length);
}

export function reconstructChange(input, cwd = process.cwd()) {
  if (!input || !['Write', 'Edit', 'MultiEdit'].includes(input.tool_name) || !input.tool_input) return { relevant: false };
  const filePath = input.tool_input.file_path || input.tool_input.file;
  const target = safePath(filePath, cwd);
  const before = readBounded(target);
  let after;
  if (input.tool_name === 'Write') {
    if (typeof input.tool_input.content !== 'string') throw new Error('missing content');
    after = input.tool_input.content;
  } else if (input.tool_name === 'Edit') {
    if (!existsSync(target)) throw new Error('missing edit target');
    after = replaceExactly(before, input.tool_input);
  } else {
    if (!existsSync(target) || !Array.isArray(input.tool_input.edits) || input.tool_input.edits.length === 0) throw new Error('invalid edits');
    after = input.tool_input.edits.reduce(replaceExactly, before);
  }
  if (Buffer.byteLength(after) > MAX_CONTENT_BYTES) throw new Error('oversized content');
  return { relevant: true, filePath, before, after };
}

function maskCommentsAndStrings(source, hashComments) {
  let output = ''; let state = 'code'; let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]; const next = source[index + 1];
    if (state === 'line') { if (current === '\n') { output += '\n'; state = 'code'; } else output += ' '; continue; }
    if (state === 'block') { if (current === '*' && next === '/') { output += '  '; index += 1; state = 'code'; } else output += current === '\n' ? '\n' : ' '; continue; }
    if (quote) { if (current === '\\') { output += '  '; index += 1; } else if (current === quote) { output += ' '; quote = ''; } else output += current === '\n' ? '\n' : ' '; continue; }
    if (current === "'" || current === '"' || current === '`') { quote = current; output += ' '; continue; }
    if (current === '/' && next === '/') { output += '  '; index += 1; state = 'line'; continue; }
    if (current === '/' && next === '*') { output += '  '; index += 1; state = 'block'; continue; }
    if (hashComments && current === '#') { output += ' '; state = 'line'; continue; }
    output += current;
  }
  return output;
}

export function scanTransport(filePath, source) {
  const hashComments = /\.(?:py|rb|ya?ml|toml|ini|conf)$/i.test(String(filePath));
  const code = maskCommentsAndStrings(source, hashComments);
  const findings = [];
  const rules = [
    ['tls-node-verification-disabled', /\brejectUnauthorized\s*[:=]\s*false\b/i],
    ['tls-go-verification-disabled', /\bInsecureSkipVerify\s*:\s*true\b/],
    ['tls-python-verification-disabled', /\bverify\s*=\s*False\b/],
    ['tls-curl-verification-disabled', /\bCURLOPT_SSL_VERIFYPEER\s*[,=:]\s*(?:false|0)\b/i]
  ];
  for (const [ruleId, pattern] of rules) if (pattern.test(code)) findings.push(ruleId);
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|#).*$/gm, '');
  // A quoted key (JSON, `{ "rejectUnauthorized": false }`) is masked with the strings above.
  if (/(["'])rejectUnauthorized\1\s*:\s*false\b/i.test(uncommented)) findings.push('tls-node-verification-disabled');
  // npm and Yarn settings: .npmrc `strict-ssl=false`, .yarnrc.yml `enableStrictSsl: false`.
  if (/^[ \t]*(?:strict-ssl|strictSsl|enableStrictSsl)[ \t]*[:=][ \t]*["']?false\b/im.test(uncommented)) findings.push('tls-registry-verification-disabled');
  // Assignments in code, .env files, shell scripts (`export`), Dockerfiles (`ENV`), YAML lists, and
  // .npmrc, with a quoted or a bare value.
  for (const match of uncommented.matchAll(/(?:^[ \t]*(?:-[ \t]*)?|[,{;][ \t]*)(?:(?:export|ENV|set)[ \t]+)?(?:(?:const|let|var)\s+)?(?:process\.env\.)?\b(NODE_TLS_REJECT_UNAUTHORIZED|registry|registryUrl|packageRegistry)\s*[:=]\s*(?:(["'])(.*?)\2|([^\s"'#;,}]+))/gim)) {
    const value = match[3] ?? match[4];
    if (match[1].toLowerCase() === 'node_tls_reject_unauthorized' && value === '0') findings.push('tls-node-verification-disabled');
    if (match[1].toLowerCase() !== 'node_tls_reject_unauthorized' && /^http:\/\/(?!localhost\b|127\.0\.0\.1\b|\[::1\])/i.test(value)) findings.push('insecure-registry-endpoint');
  }
  return findings;
}

function introduced(before, after, filePath) {
  const counts = new Map();
  for (const rule of scanTransport(filePath, before)) counts.set(rule, (counts.get(rule) || 0) + 1);
  for (const rule of scanTransport(filePath, after)) {
    const remaining = counts.get(rule) || 0;
    if (remaining) counts.set(rule, remaining - 1); else return rule;
  }
  return null;
}

export function evaluate(input, context) {
  if (!input || typeof input !== 'object' || !input.tool_input || typeof input.tool_input !== 'object') return BLOCK('transport-input-invalid', 'the hook input is malformed.');
  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) return ALLOW;
  let change = context;
  if (!change && input.tool_name === 'Write' && typeof input.tool_input.content === 'string') change = { relevant: true, filePath: input.tool_input.file_path || input.tool_input.file, before: '', after: input.tool_input.content };
  if (!change || change.invalid || typeof change.before !== 'string' || typeof change.after !== 'string' || Buffer.byteLength(change.after) > MAX_CONTENT_BYTES) return BLOCK('transport-input-invalid', 'the complete proposed file cannot be inspected safely.');
  if (!change.relevant) return ALLOW;
  const ruleId = introduced(change.before, change.after, change.filePath);
  return ruleId ? BLOCK(ruleId, 'the proposed change introduces a high-confidence transport verification downgrade.') : ALLOW;
}

async function readInput() { const chunks = []; let size = 0; for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_STDIN_BYTES) throw new Error('oversized'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { const input = await readInput(); const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd(); const result = evaluate(input, reconstructChange(input, cwd)); if (result.exitCode) process.stderr.write(`${result.message}\n`); process.exitCode = result.exitCode; }
  catch { process.stderr.write('BLOCKED by transport-security-regression-guard [transport-input-invalid]: hook input is invalid or oversized.\n'); process.exitCode = 2; }
}
