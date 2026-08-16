#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_CONTENT_BYTES = 512 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;
const ALLOW = { exitCode: 0 };
const BLOCK = (ruleId, reason) => ({ exitCode: 2, ruleId, message: `BLOCKED by container-privilege-guard [${ruleId}]: ${reason}` });
const executableName = (value) => String(value || '').replaceAll('\\', '/').split('/').at(-1).toLowerCase();

function lex(source) {
  const commands = []; let tokens = []; let value = ''; let quote = ''; let escaped = false; let dynamic = false;
  const word = () => { if (value || dynamic) tokens.push({ value, dynamic }); value = ''; dynamic = false; };
  const command = () => { word(); if (tokens.length) commands.push(tokens); tokens = []; };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { value += character; escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ''; else { value += character; if (quote === '"' && (character === '$' || character === '`')) dynamic = true; } continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '$' || character === '`') { dynamic = true; value += character; continue; }
    if (/\s/.test(character)) { word(); if (character === '\n') command(); continue; }
    if (';&|'.includes(character)) { command(); if (source[index + 1] === character) index += 1; continue; }
    value += character;
  }
  if (quote || escaped) throw new Error('malformed shell'); command(); return commands;
}

function skipOption(tokens, index, values) { const token = tokens[index]?.value || ''; if (!token.startsWith('-') || token === '--') return index; return !token.includes('=') && values.has(token) ? index + 2 : index + 1; }
function unwrap(tokens, depth = 0) {
  let cursor = 0; while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor]?.value || '')) cursor += 1;
  for (;;) {
    const name = executableName(tokens[cursor]?.value);
    if (name === 'env') { cursor += 1; while (tokens[cursor] && (tokens[cursor].value.startsWith('-') || /^[A-Za-z_]\w*=/.test(tokens[cursor].value))) cursor = /^[A-Za-z_]\w*=/.test(tokens[cursor].value) ? cursor + 1 : skipOption(tokens, cursor, new Set(['-u', '--unset', '-C', '--chdir'])); continue; }
    if (['command', 'nohup', 'setsid'].includes(name)) { cursor += 1; while (tokens[cursor]?.value.startsWith('-')) cursor += 1; continue; }
    if (['sudo', 'doas'].includes(name)) { cursor += 1; while (tokens[cursor]?.value.startsWith('-')) cursor = skipOption(tokens, cursor, new Set(['-u', '-g', '-h', '-p', '-C', '--user', '--group', '--host', '--prompt', '--chdir'])); continue; }
    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name)) { const option = tokens.findIndex((token, index) => index > cursor && (/^-[^-]*c/.test(token.value) || token.value === '--command')); if (option < 0 || !tokens[option + 1] || tokens[option + 1].dynamic || depth >= 3) throw new Error('uninspectable shell'); return normalize(tokens[option + 1].value, depth + 1); }
    break;
  }
  if (!tokens[cursor]) throw new Error('missing executable');
  return [{ executable: executableName(tokens[cursor].value), executableDynamic: tokens[cursor].dynamic, args: tokens.slice(cursor + 1) }];
}
function normalize(source, depth = 0) { if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_COMMAND_BYTES) throw new Error('invalid command'); return lex(source).flatMap((tokens) => unwrap(tokens, depth)); }

function commandRule(command) {
  for (const entry of normalize(command)) {
    if (!['docker', 'podman'].includes(entry.executable)) continue;
    if (entry.executableDynamic || entry.args.some((token) => token.dynamic)) return 'container-command-uninspectable';
    let index = 0; const globalValueOptions = new Set(['--config', '--context', '--host', '-H', '--log-level']);
    while (entry.args[index]?.value.startsWith('-')) index = skipOption(entry.args, index, globalValueOptions);
    if (!['run', 'create'].includes(entry.args[index]?.value.toLowerCase())) continue;
    const args = entry.args.slice(index + 1).map((token) => token.value);
    if (args.some((value) => /^--privileged(?:=true)?$/i.test(value))) return 'container-privileged-mode';
    if (args.some((value) => /^--(?:pid|ipc|network)=host$/i.test(value))) return 'container-host-namespace';
    if (args.some((value, offset) => /^--cap-add=(?:SYS_ADMIN|SYS_PTRACE|NET_ADMIN)$/i.test(value) || (value === '--cap-add' && /^(?:SYS_ADMIN|SYS_PTRACE|NET_ADMIN)$/i.test(args[offset + 1])))) return 'container-dangerous-capability';
    if (args.some((value, offset) => /^(?:-v|--volume)=?.*\/var\/run\/docker\.sock/i.test(value) || (/^(?:-v|--volume)$/.test(value) && /\/var\/run\/docker\.sock/.test(args[offset + 1] || '')))) return 'container-engine-socket';
    if (args.some((value) => /^--device(?:=|$)/.test(value))) return 'container-device-passthrough';
  }
  return null;
}

function isContainerConfig(filePath) { return /(?:^|\/)(?:docker-compose[^/]*\.ya?ml|compose\.ya?ml|dockerfile(?:\.[^/]*)?|(?:k8s|kubernetes|deploy|charts?|helm)\/[^/]+\.ya?ml)$/i.test(String(filePath || '').replaceAll('\\', '/')); }
export function scanContainerConfig(source) {
  const lines = source.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, '')); const findings = [];
  if (lines.some((line) => /^\s*privileged\s*:\s*true\s*$/i.test(line))) findings.push('container-privileged-mode');
  if (lines.some((line) => /^\s*host(?:PID|IPC|Network)\s*:\s*true\s*$/i.test(line))) findings.push('container-host-namespace');
  if (lines.some((line) => /^\s*(?:cap_add|capabilities)\s*:/i.test(line)) && lines.some((line) => /(?:SYS_ADMIN|SYS_PTRACE|NET_ADMIN)/i.test(line))) findings.push('container-dangerous-capability');
  if (lines.some((line) => /^\s*(?:-\s*)?(?:source\s*:\s*)?["']?\/var\/run\/docker\.sock\b/i.test(line) || /^\s*-\s*["']?[^\s]*\/var\/run\/docker\.sock/i.test(line))) findings.push('container-engine-socket');
  if (lines.some((line) => /^\s*devices\s*:\s*(?:\[.*\])?\s*$/i.test(line))) findings.push('container-device-passthrough');
  return findings;
}

function safePath(filePath, cwd) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw new Error('invalid path'); const root = realpathSync(cwd); const target = path.resolve(root, filePath); const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('outside project'); let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); if (!existsSync(cursor)) break; if (lstatSync(cursor).isSymbolicLink()) throw new Error('symlink path'); } return target;
}
function readBounded(filePath) { if (!existsSync(filePath)) return ''; const stat = lstatSync(filePath); if (!stat.isFile() || stat.size > MAX_CONTENT_BYTES) throw new Error('uninspectable file'); return readFileSync(filePath, 'utf8'); }
function replaceExactly(source, edit) { if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string' || !edit.old_string) throw new Error('invalid edit'); const first = source.indexOf(edit.old_string); if (first < 0) throw new Error('old text missing'); if (edit.replace_all === true) return source.split(edit.old_string).join(edit.new_string); if (source.indexOf(edit.old_string, first + edit.old_string.length) >= 0) throw new Error('ambiguous edit'); return source.slice(0, first) + edit.new_string + source.slice(first + edit.old_string.length); }
export function reconstructChange(input, cwd = process.cwd()) {
  if (!input || !['Write', 'Edit', 'MultiEdit'].includes(input.tool_name) || !input.tool_input) return { relevant: false }; const filePath = input.tool_input.file_path || input.tool_input.file; if (!isContainerConfig(filePath)) return { relevant: false }; const target = safePath(filePath, cwd); const before = readBounded(target); let after;
  if (input.tool_name === 'Write') { if (typeof input.tool_input.content !== 'string') throw new Error('missing content'); after = input.tool_input.content; }
  else if (input.tool_name === 'Edit') { if (!existsSync(target)) throw new Error('missing target'); after = replaceExactly(before, input.tool_input); }
  else { if (!existsSync(target) || !Array.isArray(input.tool_input.edits) || !input.tool_input.edits.length) throw new Error('invalid edits'); after = input.tool_input.edits.reduce(replaceExactly, before); }
  if (Buffer.byteLength(after) > MAX_CONTENT_BYTES) throw new Error('oversized content'); return { relevant: true, filePath, before, after };
}
function introduced(before, after) { const counts = new Map(); for (const rule of scanContainerConfig(before)) counts.set(rule, (counts.get(rule) || 0) + 1); for (const rule of scanContainerConfig(after)) { const remaining = counts.get(rule) || 0; if (remaining) counts.set(rule, remaining - 1); else return rule; } return null; }

export function evaluate(input, context) {
  if (!input || typeof input !== 'object' || !input.tool_input || typeof input.tool_input !== 'object') return BLOCK('container-input-invalid', 'the hook input is malformed.');
  if (input.tool_name === 'Bash') { try { const ruleId = commandRule(input.tool_input.command); return ruleId ? BLOCK(ruleId, 'the command grants a container high-impact host privileges.') : ALLOW; } catch { return BLOCK('container-command-uninspectable', 'the container command cannot be normalized safely.'); } }
  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) return ALLOW;
  const filePath = input.tool_input.file_path || input.tool_input.file; if (!isContainerConfig(filePath)) return ALLOW; let change = context;
  if (!change && input.tool_name === 'Write' && typeof input.tool_input.content === 'string') change = { relevant: true, before: '', after: input.tool_input.content };
  if (!change || change.invalid || typeof change.before !== 'string' || typeof change.after !== 'string' || Buffer.byteLength(change.after) > MAX_CONTENT_BYTES) return BLOCK('container-input-invalid', 'the complete proposed container configuration cannot be inspected safely.');
  if (!change.relevant) return ALLOW; const ruleId = introduced(change.before, change.after); return ruleId ? BLOCK(ruleId, 'the proposed container configuration expands host privilege.') : ALLOW;
}

async function readInput() { const chunks = []; let size = 0; for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_STDIN_BYTES) throw new Error('oversized'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const input = await readInput(); const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(); const context = input.tool_name === 'Bash' ? undefined : reconstructChange(input, cwd); const result = evaluate(input, context); if (result.exitCode) process.stderr.write(`${result.message}\n`); process.exitCode = result.exitCode; }
  catch { process.stderr.write('BLOCKED by container-privilege-guard [container-input-invalid]: hook input is invalid or oversized.\n'); process.exitCode = 2; }
}
