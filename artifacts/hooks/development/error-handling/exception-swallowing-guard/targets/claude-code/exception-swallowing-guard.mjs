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


const HASH_COMMENT_FILE = /\.(?:py|rb|php)$/i;
// The standard optional-dependency idiom: `except ImportError: pass` around an import is a
// deliberate fallback, not a swallowed error.
const OPTIONAL_IMPORT_ERRORS = /^\(?\s*(?:ImportError|ModuleNotFoundError)(?:\s*,\s*(?:ImportError|ModuleNotFoundError))*\s*,?\s*\)?$/;

// Single left-to-right pass that blanks comment text and string contents, preserving length and
// newlines so match offsets still address the original source. Handler shapes are then matched
// against code only, so a string or comment that merely *describes* a swallowed handler cannot be
// mistaken for one. Comment positions are retained: a comment inside an otherwise empty handler is
// an explicit, reviewable statement of intent and exempts that handler.
export function scanSource(text, file = '') {
  const hashComments = HASH_COMMENT_FILE.test(file);
  const slashComments = !/\.(?:py|rb)$/i.test(file);
  const code = text.split('');
  const comment = new Uint8Array(text.length);
  const blank = (start, end, isComment) => {
    for (let index = start; index < end && index < text.length; index += 1) {
      if (text[index] !== '\n') code[index] = ' ';
      if (isComment) comment[index] = 1;
    }
  };
  let cursor = 0;
  while (cursor < text.length) {
    const three = text.slice(cursor, cursor + 3);
    if (three === '"""' || three === "'''") {
      const end = text.indexOf(three, cursor + 3);
      const stop = end < 0 ? text.length : end + 3;
      blank(cursor, stop, false); cursor = stop; continue;
    }
    const two = text.slice(cursor, cursor + 2);
    if (slashComments && two === '/*') {
      const end = text.indexOf('*/', cursor + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(cursor, stop, true); cursor = stop; continue;
    }
    if ((slashComments && two === '//') || (hashComments && text[cursor] === '#')) {
      let end = text.indexOf('\n', cursor);
      if (end < 0) end = text.length;
      blank(cursor, end, true); cursor = end; continue;
    }
    if (text[cursor] === '"' || text[cursor] === "'" || text[cursor] === '`') {
      const quote = text[cursor];
      let end = cursor + 1;
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end] === quote) { end += 1; break; }
        if (text[end] === '\n' && quote !== '`') break;
        end += 1;
      }
      blank(cursor, end, false); cursor = end; continue;
    }
    cursor += 1;
  }
  return { code: code.join(''), comment };
}

export function swallowedHandlerInventory(text, file = '') {
  const { code, comment } = scanSource(text, file);
  const documented = (start, end) => {
    for (let index = start; index < end; index += 1) if (comment[index]) return true;
    return false;
  };
  const dialects = [
    ['empty-braced-catch', /catch(?:\s*\([^)]*\))?\s*\{\s*\}/g],
    ['ignored-promise-rejection', /\.catch\s*\(\s*(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>\s*(?:\{\s*\}|undefined\b|null\b)\s*\)/g],
    ['ignored-promise-function', /\.catch\s*\(\s*(?:async\s+)?function(?:\s+[A-Za-z_]\w*)?\s*\([^)]*\)\s*\{\s*\}\s*\)/g],
    ['python-pass-handler', /except([^:\n]*)?:\s*(?:pass|\.\.\.)[^\S\n]*(?:$|\n)/gm],
    ['ruby-empty-rescue', /rescue(?:[^\n]*)?\n\s*end\b/g]
  ];
  const inventory = [];
  for (const [dialect, expression] of dialects) {
    for (const match of code.matchAll(expression)) {
      const start = match.index;
      const end = start + match[0].length;
      if (documented(start, end)) continue;
      if (dialect === 'python-pass-handler' && OPTIONAL_IMPORT_ERRORS.test((match[1] || '').trim())) continue;
      inventory.push({ dialect, offset: start });
    }
  }
  return inventory;
}
export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || !input.tool_name) return block('exception-swallowing-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Write|Edit|MultiEdit)$/.test(input.tool_name)) return allow();
  if (!input.tool_input || typeof input.tool_input !== 'object' || typeof (input.tool_input.file_path || input.tool_input.file) !== 'string') return block('exception-swallowing-input-invalid', 'the file edit input is malformed');
  if (!sourceFile(context.file || input.tool_input.file_path || input.tool_input.file || '')) return allow();
  if (!context.complete) return block('exception-handler-unverified', 'the exception-handler edit could not be reconstructed');
  const target = context.file || input.tool_input.file_path || input.tool_input.file || '';
  const before = new Map(); const after = new Map();
  for (const item of swallowedHandlerInventory(context.before || '', target)) before.set(item.dialect, (before.get(item.dialect) || 0) + 1);
  for (const item of swallowedHandlerInventory(context.proposed || '', target)) after.set(item.dialect, (after.get(item.dialect) || 0) + 1);
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
