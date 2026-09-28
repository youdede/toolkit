#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by unsafe-deserialization-guard [' + ruleId + ']: ' + detail + '.' }; }
function sourceFile(file) { return /\.(?:[cm]?[jt]sx?|py|rb|php|java|kt|kts|cs|go|rs|swift|vue|svelte)$/i.test(file); }
function rebuildRevision(input, before) {
  const tool = input?.tool_input || {}; if (typeof tool.content === 'string') return { complete: true, proposed: tool.content };
  const edits = Array.isArray(tool.edits) ? tool.edits : [tool]; let proposed = before;
  for (const edit of edits) { if (typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string' || !edit.old_string) return { complete: false, proposed: '' }; const position = proposed.indexOf(edit.old_string); if (position < 0 || (edit.replace_all !== true && proposed.indexOf(edit.old_string, position + edit.old_string.length) >= 0)) return { complete: false, proposed: '' }; proposed = edit.replace_all === true ? proposed.split(edit.old_string).join(edit.new_string) : proposed.slice(0, position) + edit.new_string + proposed.slice(position + edit.old_string.length); }
  return { complete: true, proposed };
}
function within(root, candidate) { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function nearestExistingParent(candidate) { let cursor = candidate; while (!existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) return cursor; cursor = parent; } return cursor; }
// A relative path resolves against CLAUDE_PROJECT_DIR, else cwd. A path inside that root must not leave
// it through a symbolic-link ancestor. A file outside it (another package after a cd into a
// subdirectory) is inspected the same way; its target file is never read through a symbolic link.
export function collectContext(input, cwd = process.cwd()) {
  const file = input?.tool_input?.file_path || input?.tool_input?.file || ''; if (typeof file !== 'string' || !file) return { file: '', complete: false };
  const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd); const absolute = path.resolve(root, file);
  try { if (within(root, absolute) && !within(realpathSync(root), realpathSync(nearestExistingParent(absolute)))) return { file, complete: false, inspectionError: 'path-alias-escape' }; let before = ''; if (existsSync(absolute)) { const stat = lstatSync(absolute); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) return { file, complete: false, inspectionError: 'unsafe-target' }; before = readFileSync(absolute, 'utf8'); } return { file, before, ...rebuildRevision(input, before) }; }
  catch { return { file, complete: false, inspectionError: 'read-failed' }; }
}

// One pass, so a string is masked before a comment marker inside it is seen: `u = 'http://a'` no
// longer hides the rest of the line. Python and Ruby comments start with `#`; the other languages use
// `//` and `/* */`. A string becomes "" (Python triple quotes may span lines); an unterminated quote
// on its line is left as code.
function codeWithoutComments(text, file) {
  const hash = /\.(?:py|rb)$/i.test(file);
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'") {
      const close = /\.py$/i.test(file) && text.startsWith(character.repeat(3), index) ? character.repeat(3) : character;
      let cursor = index + close.length;
      while (cursor < text.length && !text.startsWith(close, cursor) && (close.length === 3 || text[cursor] !== '\n')) cursor += text[cursor] === '\\' ? 2 : 1;
      if (cursor < text.length && text.startsWith(close, cursor)) { output += '""'; index = cursor + close.length - 1; continue; }
    }
    const comment = hash ? character === '#' : character === '/' && text[index + 1] === '/';
    if (comment) { while (index + 1 < text.length && text[index + 1] !== '\n') index += 1; output += ' '; continue; }
    if (!hash && character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      output += ' ';
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    output += character;
  }
  return output;
}
function countMatches(source, expression) { return [...source.matchAll(expression)].length; }
export function unsafeLoaderInventory(text, file = '') {
  const source = codeWithoutComments(text, file); const counts = new Map(); const add = (name, count) => { if (count) counts.set(name, (counts.get(name) || 0) + count); };
  if (/\.py$/i.test(file)) {
    const pickleAliases = new Set(['pickle']); const yamlAliases = new Set(['yaml']);
    for (const match of source.matchAll(/\bimport\s+pickle\s+as\s+([A-Za-z_]\w*)/g)) pickleAliases.add(match[1]);
    for (const match of source.matchAll(/\bimport\s+yaml\s+as\s+([A-Za-z_]\w*)/g)) yamlAliases.add(match[1]);
    for (const alias of pickleAliases) add('python-pickle', countMatches(source, new RegExp('\\b' + alias + '\\s*\\.\\s*loads?\\s*\\(', 'g')));
    for (const match of source.matchAll(/\bfrom\s+pickle\s+import\s+loads?(?:\s+as\s+([A-Za-z_]\w*))?/g)) add('python-pickle', countMatches(source, new RegExp('\\b' + (match[1] || 'loads?') + '\\s*\\(', 'g')));
    for (const alias of yamlAliases) add('python-yaml-unsafe-loader', countMatches(source, new RegExp('\\b' + alias + '\\s*\\.\\s*load\\s*\\((?![^\\n)]*(?:SafeLoader|safe_load))', 'g')));
    for (const alias of yamlAliases) add('python-yaml-unsafe-loader', countMatches(source, new RegExp('\\b' + alias + '\\s*\\.\\s*unsafe_load(?:_all)?\\s*\\(', 'g')));
    for (const match of source.matchAll(/\bfrom\s+yaml\s+import\s+unsafe_load(?:\s+as\s+([A-Za-z_]\w*))?/g)) add('python-yaml-unsafe-loader', countMatches(source, new RegExp('\\b' + (match[1] || 'unsafe_load') + '\\s*\\(', 'g')));
    for (const match of source.matchAll(/\bfrom\s+yaml\s+import\s+load(?:\s+as\s+([A-Za-z_]\w*))?/g)) add('python-yaml-unsafe-loader', countMatches(source, new RegExp('\\b' + (match[1] || 'load') + '\\s*\\((?![^\\n)]*SafeLoader)', 'g')));
  }
  if (/\.rb$/i.test(file)) add('ruby-marshal', countMatches(source, /\bMarshal\s*\.\s*(?:load|restore)\b/g));
  if (/\.php$/i.test(file)) add('php-unserialize', countMatches(source, /\bunserialize\s*\(/g));
  // BinaryFormatter is usually created on one line and used on another, so creating one counts.
  if (/\.cs$/i.test(file)) add('dotnet-binary-formatter', countMatches(source, /\bnew\s+BinaryFormatter\s*[({]/g));
  if (/\.(?:java|kt|kts)$/i.test(file)) { add('java-object-stream', countMatches(source, /\bnew\s+ObjectInputStream\s*\(/g)); add('java-read-object', countMatches(source, /\.\s*readObject\s*\(/g)); }
  return [...counts].map(([loader, count]) => ({ loader, count }));
}
export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || !input.tool_name) return block('unsafe-deserialization-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Write|Edit|MultiEdit)$/.test(input.tool_name)) return allow();
  if (!input.tool_input || typeof input.tool_input !== 'object' || typeof (input.tool_input.file_path || input.tool_input.file) !== 'string') return block('unsafe-deserialization-input-invalid', 'the file edit input is malformed');
  const file = context.file || input.tool_input.file_path || input.tool_input.file; if (!sourceFile(file)) return allow();
  if (!context.complete) return block('unsafe-deserialization-unverified', 'the source edit could not be reconstructed');
  const before = new Map(unsafeLoaderInventory(context.before || '', file).map((item) => [item.loader, item.count]));
  for (const item of unsafeLoaderInventory(context.proposed || '', file)) if (item.count > (before.get(item.loader) || 0)) return block('unsafe-deserialization-api-added', 'the change introduces a known executable deserialization primitive');
  return allow();
}

async function receiveEnvelope() { const chunks = []; let received = 0; for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); } try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error('hook input is not valid JSON'); } }
async function runHook() { let result; try { const input = await receiveEnvelope(); result = evaluate(input, collectContext(input)); } catch (error) { result = block('unsafe-deserialization-input-invalid', error.message); } if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode; }
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
