#!/usr/bin/env node

import { existsSync, lstatSync, openSync, closeSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by binary-mutation-guard [' + ruleId + ']: ' + detail + '.' }; }


const MAX_BINARY_PREFIX = 64 * 1024;
function within(root, candidate) { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function nearestExistingParent(candidate) { let cursor = candidate; while (!existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) return cursor; cursor = parent; } return cursor; }
export function collectContext(input, cwd = process.cwd()) {
  const file = input?.tool_input?.file_path || input?.tool_input?.file || '';
  if (typeof file !== 'string' || !file) return { file: '', existing: false };
  const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd); const absolute = path.resolve(root, file);
  // A target that does not exist yet is not a binary to protect, wherever it is.
  try { lstatSync(absolute); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { file, existing: false }; }
  if (!within(root, absolute)) return { file, existing: true, inspectionError: 'path-escape' };
  try {
    const canonicalRoot = realpathSync(root); const boundary = realpathSync(nearestExistingParent(absolute));
    if (!within(canonicalRoot, boundary)) return { file, existing: true, inspectionError: 'path-alias-escape' };
    if (!existsSync(absolute)) return { file, existing: false };
    const stat = lstatSync(absolute); if (!stat.isFile() || stat.isSymbolicLink()) return { file, existing: true, symlink: stat.isSymbolicLink(), inspectionError: 'unsafe-target' };
    const descriptor = openSync(absolute, 'r');
    try { const buffer = Buffer.alloc(Math.min(stat.size, MAX_BINARY_PREFIX)); const bytes = readSync(descriptor, buffer, 0, buffer.length, 0); return { file, existing: true, prefix: buffer.subarray(0, bytes) }; }
    finally { closeSync(descriptor); }
  } catch { return { file, existing: true, inspectionError: 'read-failed' }; }
}


const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|bz2|xz|7z|wasm|class|jar|exe|dll|dylib|so|woff2?|ttf|otf|mp[34]|mov)$/i;
function binaryPrefix(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) || buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) return false;
  const signatures = ['89504e47','ffd8ff','47494638','52494646','25504446','504b0304','1f8b08','7f454c46','0061736d','cafebabe','52617221','377abcaf271c','53514c69746520666f726d6174203300'];
  const head = buffer.subarray(0, 16).toString('hex');
  return buffer.includes(0) || signatures.some((signature) => head.startsWith(signature));
}
export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || !input.tool_name) return block('binary-mutation-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Write|Edit|MultiEdit)$/.test(input.tool_name)) return allow();
  if (!input.tool_input || typeof input.tool_input !== 'object' || typeof (input.tool_input.file_path || input.tool_input.file) !== 'string') return block('binary-mutation-input-invalid', 'the file edit input is malformed');
  const file = context.file || input.tool_input.file_path || input.tool_input.file;
  if (!context.existing) return allow();
  if (context.symlink || context.inspectionError) return block('binary-target-unverified', 'the existing target is outside the project, behind a link, or unreadable, so it cannot be inspected safely');
  if (BINARY_EXTENSIONS.test(file) || binaryPrefix(context.prefix)) return block('binary-text-mutation', 'a text editing tool targeted an existing binary file');
  return allow();
}

async function receiveEnvelope() {
  const chunks = []; let received = 0;
  for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); }
  try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; }
  catch { throw new Error('hook input is not valid JSON'); }
}
async function runHook() {
  let result;
  try { const input = await receiveEnvelope(); result = evaluate(input, collectContext(input)); }
  catch (error) { result = block('binary-mutation-input-invalid', error.message); }
  if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
