#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_CONTENT_BYTES = 512 * 1024;
const ALLOW = { exitCode: 0 };
const BLOCK = (ruleId, reason) => ({ exitCode: 2, ruleId, message: `BLOCKED by dynamic-code-execution-guard [${ruleId}]: ${reason}` });

function safePath(filePath, cwd) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) throw new Error('invalid path');
  const root = realpathSync(cwd); const target = path.resolve(root, filePath); const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('outside project');
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); if (!existsSync(cursor)) break; if (lstatSync(cursor).isSymbolicLink()) throw new Error('symlink path'); }
  return target;
}

function readBounded(filePath) { if (!existsSync(filePath)) return ''; const stat = lstatSync(filePath); if (!stat.isFile() || stat.size > MAX_CONTENT_BYTES) throw new Error('uninspectable file'); return readFileSync(filePath, 'utf8'); }
function replaceExactly(source, edit) {
  if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string' || edit.old_string.length === 0) throw new Error('invalid edit');
  const first = source.indexOf(edit.old_string); if (first < 0) throw new Error('old text missing');
  if (edit.replace_all === true) return source.split(edit.old_string).join(edit.new_string);
  if (source.indexOf(edit.old_string, first + edit.old_string.length) >= 0) throw new Error('ambiguous edit');
  return source.slice(0, first) + edit.new_string + source.slice(first + edit.old_string.length);
}

export function reconstructChange(input, cwd = process.cwd()) {
  if (!input || !['Write', 'Edit', 'MultiEdit'].includes(input.tool_name) || !input.tool_input) return { relevant: false };
  const filePath = input.tool_input.file_path || input.tool_input.file; const target = safePath(filePath, cwd); const before = readBounded(target); let after;
  if (input.tool_name === 'Write') { if (typeof input.tool_input.content !== 'string') throw new Error('missing content'); after = input.tool_input.content; }
  else if (input.tool_name === 'Edit') { if (!existsSync(target)) throw new Error('missing edit target'); after = replaceExactly(before, input.tool_input); }
  else { if (!existsSync(target) || !Array.isArray(input.tool_input.edits) || input.tool_input.edits.length === 0) throw new Error('invalid edits'); after = input.tool_input.edits.reduce(replaceExactly, before); }
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

function executableCode(filePath, source) {
  const isJavaScript = /\.(?:js|jsx|mjs|cjs|ts|tsx)$/i.test(String(filePath));
  const masked = maskCommentsAndStrings(source, !isJavaScript && /\.(?:py|rb|php)$/i.test(String(filePath)));
  if (!isJavaScript) return masked;
  const templateExpressions = [];
  for (const match of source.matchAll(/\$\{([\s\S]*?)\}/g)) templateExpressions.push(maskCommentsAndStrings(match[1], false));
  return `${masked}\n${templateExpressions.join('\n')}`.replace(/#(?:eval|exec)\b/g, ' private ');
}

export function scanDynamicCode(filePath, source) {
  const normalizedPath = String(filePath || '').toLowerCase(); const code = executableCode(normalizedPath, source); const findings = [];
  if (/\.(?:js|jsx|mjs|cjs|ts|tsx)$/.test(normalizedPath) && (/\beval\s*\(/.test(code) || /\bnew\s+Function\s*\(/.test(code))) findings.push('javascript-dynamic-execution');
  if (/\.py$/.test(normalizedPath) && /\b(?:eval|exec)\s*\(/.test(code)) findings.push('python-dynamic-execution');
  if (/\.php$/.test(normalizedPath) && /\b(?:eval|assert)\s*\(/.test(code)) findings.push('php-dynamic-execution');
  if (/\.rb$/.test(normalizedPath) && /\b(?:eval|class_eval|module_eval|instance_eval)\s*\(/.test(code)) findings.push('ruby-dynamic-execution');
  return findings;
}

function introduced(before, after, filePath) {
  const counts = new Map(); for (const rule of scanDynamicCode(filePath, before)) counts.set(rule, (counts.get(rule) || 0) + 1);
  for (const rule of scanDynamicCode(filePath, after)) { const remaining = counts.get(rule) || 0; if (remaining) counts.set(rule, remaining - 1); else return rule; }
  return null;
}

export function evaluate(input, context) {
  if (!input || typeof input !== 'object' || !input.tool_input || typeof input.tool_input !== 'object') return BLOCK('dynamic-code-input-invalid', 'the hook input is malformed.');
  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) return ALLOW;
  let change = context;
  if (!change && input.tool_name === 'Write' && typeof input.tool_input.content === 'string') change = { relevant: true, filePath: input.tool_input.file_path || input.tool_input.file, before: '', after: input.tool_input.content };
  if (!change || change.invalid || typeof change.filePath !== 'string' || typeof change.before !== 'string' || typeof change.after !== 'string' || Buffer.byteLength(change.after) > MAX_CONTENT_BYTES) return BLOCK('dynamic-code-input-invalid', 'the complete proposed file cannot be inspected safely.');
  if (!change.relevant) return ALLOW;
  const ruleId = introduced(change.before, change.after, change.filePath);
  return ruleId ? BLOCK(ruleId, 'the proposed source introduces a direct dynamic code execution primitive.') : ALLOW;
}

async function readInput() { const chunks = []; let size = 0; for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_STDIN_BYTES) throw new Error('oversized'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const input = await readInput(); const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(); const result = evaluate(input, reconstructChange(input, cwd)); if (result.exitCode) process.stderr.write(`${result.message}\n`); process.exitCode = result.exitCode; }
  catch { process.stderr.write('BLOCKED by dynamic-code-execution-guard [dynamic-code-input-invalid]: hook input is invalid or oversized.\n'); process.exitCode = 2; }
}
