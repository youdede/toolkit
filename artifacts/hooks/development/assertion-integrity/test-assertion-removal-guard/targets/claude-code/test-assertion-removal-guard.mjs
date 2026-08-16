#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by test-assertion-removal-guard [' + ruleId + ']: ' + detail + '.' }; }
function within(root, candidate) { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function nearestExistingParent(candidate) { let cursor = candidate; while (!existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) return cursor; cursor = parent; } return cursor; }
function rebuildRevision(input, before) {
  const tool = input?.tool_input || {}; if (typeof tool.content === 'string') return { complete: true, proposed: tool.content };
  const edits = Array.isArray(tool.edits) ? tool.edits : [tool]; let proposed = before;
  for (const edit of edits) { if (typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string' || !edit.old_string) return { complete: false, proposed: '' }; const position = proposed.indexOf(edit.old_string); if (position < 0 || (edit.replace_all !== true && proposed.indexOf(edit.old_string, position + edit.old_string.length) >= 0)) return { complete: false, proposed: '' }; proposed = edit.replace_all === true ? proposed.split(edit.old_string).join(edit.new_string) : proposed.slice(0, position) + edit.new_string + proposed.slice(position + edit.old_string.length); }
  return { complete: true, proposed };
}
export function collectContext(input, cwd = process.cwd()) {
  const file = input?.tool_input?.file_path || input?.tool_input?.file || ''; if (typeof file !== 'string' || !file) return { file: '', complete: false };
  const root = path.resolve(input?.cwd || cwd); const absolute = path.resolve(root, file); if (!within(root, absolute)) return { file, complete: false, inspectionError: 'path-escape' };
  try { const canonicalRoot = realpathSync(root); const boundary = realpathSync(nearestExistingParent(absolute)); if (!within(canonicalRoot, boundary)) return { file, complete: false, inspectionError: 'path-alias-escape' }; let before = ''; if (existsSync(absolute)) { const stat = lstatSync(absolute); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) return { file, complete: false, inspectionError: 'unsafe-target' }; before = readFileSync(absolute, 'utf8'); } return { file, before, ...rebuildRevision(input, before) }; }
  catch { return { file, complete: false, inspectionError: 'read-failed' }; }
}

function isTestFile(file) { return /(?:^|\/)(?:test|tests|spec|specs)\/|(?:\.test|\.spec|_test|_spec)\.[^/]+$/i.test(file); }
function assertionCount(text) {
  const source = maskSyntax(text);
  const expressions = [
    /\bexpect\s*\(/g, /\bassert(?:Equal|True|False|Raises|That|_eq|_ne|_ok)?\s*[.!(]/g, /\b(?:should|fail)\s*[.(]/g,
    /^\s*assert\s+[^=]/gm, /\b(?:self\.)?assert[A-Z]\w*\s*\(/g, /\bpytest\.raises\s*\(/g,
    /\b(?:require|assert)\.(?:Equal|NoError|Error|True|False|NotNil)\s*\(/g, /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/g,
    /\bassert(?:_eq|_ne|_matches)?!\s*\(/g
  ];
  return expressions.reduce((total, expression) => total + [...source.matchAll(expression)].length, 0);
}
function maskSyntax(text) {
  let result = ''; let quote = ''; let escaped = false; let lineComment = false; let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]; const next = text[index + 1];
    if (lineComment) { if (character === '\n') { lineComment = false; result += '\n'; } else result += ' '; continue; }
    if (blockComment) { if (character === '*' && next === '/') { result += '  '; index += 1; blockComment = false; } else result += character === '\n' ? '\n' : ' '; continue; }
    if (quote) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === quote) quote = ''; result += character === '\n' ? '\n' : ' '; continue; }
    if (character === '/' && next === '/') { result += '  '; index += 1; lineComment = true; continue; }
    if (character === '/' && next === '*') { result += '  '; index += 1; blockComment = true; continue; }
    if (character === "'" || character === '"' || character === '`') { quote = character; result += ' '; continue; }
    result += character;
  }
  return result;
}
function matchingDelimiter(masked, start, opening, closing) {
  let depth = 0; for (let index = start; index < masked.length; index += 1) { if (masked[index] === opening) depth += 1; else if (masked[index] === closing && --depth === 0) return index; } return -1;
}
function javascriptSegments(text) {
  const expression = /\b(?:it|test)\s*\(\s*['"`]([^'"`\r\n]+)['"`]\s*,/g; const masked = maskSyntax(text); const occurrences = new Map(); const segments = new Map();
  for (const match of text.matchAll(expression)) {
    const open = masked.indexOf('(', match.index); const close = matchingDelimiter(masked, open, '(', ')'); if (close < 0) continue;
    const ordinal = occurrences.get(match[1]) || 0; occurrences.set(match[1], ordinal + 1); segments.set(match[1] + '#' + ordinal, assertionCount(text.slice(match.index, close + 1)));
  }
  return segments;
}
function bracedSegments(text, expression) {
  const masked = maskSyntax(text); const occurrences = new Map(); const segments = new Map();
  for (const match of text.matchAll(expression)) { const open = masked.indexOf('{', match.index + match[0].length); const close = matchingDelimiter(masked, open, '{', '}'); if (open < 0 || close < 0) continue; const ordinal = occurrences.get(match[1]) || 0; occurrences.set(match[1], ordinal + 1); segments.set(match[1] + '#' + ordinal, assertionCount(text.slice(match.index, close + 1))); }
  return segments;
}
function pythonSegments(text) {
  const lines = text.split(/\r?\n/); const segments = new Map(); const occurrences = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:async\s+)?def\s+(test_[A-Za-z_]\w*)\s*\(/.exec(lines[index]); if (!match) continue;
    const indent = match[1].replace(/\t/g, '    ').length; let end = index + 1;
    while (end < lines.length) { if (lines[end].trim() && /^\s*/.exec(lines[end])[0].replace(/\t/g, '    ').length <= indent) break; end += 1; }
    const ordinal = occurrences.get(match[2]) || 0; occurrences.set(match[2], ordinal + 1); segments.set(match[2] + '#' + ordinal, assertionCount(lines.slice(index, end).join('\n'))); index = end - 1;
  }
  return segments;
}
function testSegments(text, file) {
  if (/\.py$/i.test(file)) return pythonSegments(text);
  if (/\.go$/i.test(file)) return bracedSegments(text, /\bfunc\s+(Test[A-Z]\w*)\s*\([^)]*\)/g);
  if (/\.rs$/i.test(file)) return bracedSegments(text, /#\s*\[\s*test\s*\]\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\([^)]*\)/g);
  return javascriptSegments(text);
}
export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || !input.tool_name) return block('test-assertion-removal-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Write|Edit|MultiEdit)$/.test(input.tool_name)) return allow();
  if (!input.tool_input || typeof input.tool_input !== 'object' || typeof (input.tool_input.file_path || input.tool_input.file) !== 'string') return block('test-assertion-removal-input-invalid', 'the file edit input is malformed');
  const file = context.file || input.tool_input.file_path || input.tool_input.file; if (!isTestFile(file)) return allow();
  if (!context.complete) return block('test-assertion-unverified', 'the test edit could not be reconstructed');
  const before = testSegments(context.before || '', file); const after = testSegments(context.proposed || '', file);
  for (const [identity, count] of before) if (count > 0 && after.has(identity) && after.get(identity) === 0) return block('last-test-assertion-removed', 'a retained test loses its final recognizable assertion');
  return allow();
}

async function receiveEnvelope() { const chunks = []; let received = 0; for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); } try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error('hook input is not valid JSON'); } }
async function runHook() { let result; try { const input = await receiveEnvelope(); result = evaluate(input, collectContext(input)); } catch (error) { result = block('test-assertion-removal-input-invalid', error.message); } if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode; }
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
