#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by exception-swallowing-guard [' + ruleId + ']: ' + detail + '.' }; }

function sourceFile(file) { return /\.(?:[cm]?[jt]sx?|py|rb|php|java|kt|kts|cs|go|rs|swift)$/i.test(file); }

const MAX_TEXT_BYTES = 512 * 1024;
function within(root, candidate) { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function nearestExistingParent(candidate) { let cursor = candidate; while (!existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) return cursor; cursor = parent; } return cursor; }
function rebuildRevision(input, before) {
  const tool = input?.tool_input || {};
  if (typeof tool.content === 'string') return { complete: true, proposed: tool.content };
  const edits = Array.isArray(tool.edits) ? tool.edits : [tool]; let proposed = before;
  for (const edit of edits) {
    if (typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string' || edit.old_string.length === 0) return { complete: false, proposed: '' };
    const position = proposed.indexOf(edit.old_string);
    if (position < 0 || (edit.replace_all !== true && proposed.indexOf(edit.old_string, position + edit.old_string.length) >= 0)) return { complete: false, proposed: '' };
    proposed = edit.replace_all === true ? proposed.split(edit.old_string).join(edit.new_string) : proposed.slice(0, position) + edit.new_string + proposed.slice(position + edit.old_string.length);
  }
  return { complete: true, proposed };
}
export function collectContext(input, cwd = process.cwd()) {
  const file = input?.tool_input?.file_path || input?.tool_input?.file || '';
  if (typeof file !== 'string' || !file) return { file: '', complete: false };
  const root = path.resolve(input?.cwd || cwd); const absolute = path.resolve(root, file);
  if (!within(root, absolute)) return { file, complete: false, inspectionError: 'path-escape' };
  try {
    const canonicalRoot = realpathSync(root); const boundary = realpathSync(nearestExistingParent(absolute));
    if (!within(canonicalRoot, boundary)) return { file, complete: false, inspectionError: 'path-alias-escape' };
    let before = '';
    if (existsSync(absolute)) {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) return { file, complete: false, inspectionError: 'unsafe-target' };
      before = readFileSync(absolute, 'utf8');
    }
    return { file, before, ...rebuildRevision(input, before) };
  } catch { return { file, complete: false, inspectionError: 'read-failed' }; }
}


export function swallowedHandlerInventory(text) {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*#.*$/gm, '');
  const dialects = [
    ['empty-braced-catch', /catch(?:\s*\([^)]*\))?\s*\{\s*\}/g],
    ['ignored-promise-rejection', /\.catch\s*\(\s*(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>\s*(?:\{\s*\}|undefined\b|null\b)\s*\)/g],
    ['ignored-promise-function', /\.catch\s*\(\s*(?:async\s+)?function(?:\s+[A-Za-z_]\w*)?\s*\([^)]*\)\s*\{\s*\}\s*\)/g],
    ['python-pass-handler', /except(?:\s+[^:\n]+)?\s*:\s*(?:pass|\.\.\.)(?:\s*#.*)?\s*(?:$|\n)/gm],
    ['ruby-empty-rescue', /rescue(?:\s+[^\n]+)?\s*\n\s*(?:#.*\n\s*)?end\b/g]
  ];
  const inventory = [];
  for (const [dialect, expression] of dialects) for (const match of source.matchAll(expression)) inventory.push({ dialect, offset: match.index });
  return inventory;
}
export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || !input.tool_name) return block('exception-swallowing-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Write|Edit|MultiEdit)$/.test(input.tool_name)) return allow();
  if (!input.tool_input || typeof input.tool_input !== 'object' || typeof (input.tool_input.file_path || input.tool_input.file) !== 'string') return block('exception-swallowing-input-invalid', 'the file edit input is malformed');
  if (!sourceFile(context.file || input.tool_input.file_path || input.tool_input.file || '')) return allow();
  if (!context.complete) return block('exception-handler-unverified', 'the exception-handler edit could not be reconstructed');
  const before = new Map(); const after = new Map();
  for (const item of swallowedHandlerInventory(context.before || '')) before.set(item.dialect, (before.get(item.dialect) || 0) + 1);
  for (const item of swallowedHandlerInventory(context.proposed || '')) after.set(item.dialect, (after.get(item.dialect) || 0) + 1);
  for (const [dialect, count] of after) if (count > (before.get(dialect) || 0)) return block('exception-swallowing-added', 'the change adds an empty exception or rejection handler');
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
  catch (error) { result = block('exception-swallowing-input-invalid', error.message); }
  if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
