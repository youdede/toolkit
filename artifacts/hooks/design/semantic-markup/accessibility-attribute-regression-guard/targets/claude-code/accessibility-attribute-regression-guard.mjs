#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by accessibility-attribute-regression-guard [' + ruleId + ']: ' + detail + '.' }; }
function within(root, candidate) { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function nearestExistingParent(candidate) { let cursor = candidate; while (!existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) return cursor; cursor = parent; } return cursor; }
function rebuildRevision(input, before) { const tool = input?.tool_input || {}; if (typeof tool.content === 'string') return { complete: true, proposed: tool.content }; const edits = Array.isArray(tool.edits) ? tool.edits : [tool]; let proposed = before; for (const edit of edits) { if (typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string' || !edit.old_string) return { complete: false, proposed: '' }; const position = proposed.indexOf(edit.old_string); if (position < 0 || (edit.replace_all !== true && proposed.indexOf(edit.old_string, position + edit.old_string.length) >= 0)) return { complete: false, proposed: '' }; proposed = edit.replace_all === true ? proposed.split(edit.old_string).join(edit.new_string) : proposed.slice(0, position) + edit.new_string + proposed.slice(position + edit.old_string.length); } return { complete: true, proposed }; }
export function collectContext(input, cwd = process.cwd()) {
  const file = input?.tool_input?.file_path || input?.tool_input?.file || ''; if (typeof file !== 'string' || !file) return { file: '', complete: false }; const root = path.resolve(input?.cwd || cwd); const absolute = path.resolve(root, file); if (!within(root, absolute)) return { file, complete: false, inspectionError: 'path-escape' };
  try { const canonicalRoot = realpathSync(root); const boundary = realpathSync(nearestExistingParent(absolute)); if (!within(canonicalRoot, boundary)) return { file, complete: false, inspectionError: 'path-alias-escape' }; let before = ''; if (existsSync(absolute)) { const stat = lstatSync(absolute); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) return { file, complete: false, inspectionError: 'unsafe-target' }; before = readFileSync(absolute, 'utf8'); } return { file, before, ...rebuildRevision(input, before) }; } catch { return { file, complete: false, inspectionError: 'read-failed' }; }
}

function markup(file) { return /\.(?:html?|jsx|tsx|vue|svelte)$/i.test(file); }
function parseAttributes(raw) {
  const attributes = new Map();
  for (const match of raw.matchAll(/\b([:@A-Za-z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^{}]*)\}|([^\s>]+)))?/g)) attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? match[5] ?? '');
  return attributes;
}
function elements(text) {
  const result = new Map(); const ordinals = new Map();
  for (const match of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<([A-Za-z][\w:-]*)\b([^<>]*)>/g)) {
    const tag = match[1].toLowerCase(); const attributes = parseAttributes(match[2]);
    const stable = ['id', 'data-testid', 'data-test', 'name'].find((name) => attributes.has(name) && attributes.get(name));
    const ordinal = ordinals.get(tag) || 0; ordinals.set(tag, ordinal + 1); const key = stable ? stable + ':' + attributes.get(stable) : tag + '#' + ordinal;
    result.set(key, { tag, attributes });
  }
  return result;
}
function implicitRole(element) {
  if (element.tag === 'button') return 'button'; if (element.tag === 'a' && element.attributes.has('href')) return 'link'; if (element.tag === 'img') return 'img';
  if (element.tag === 'select') return 'combobox'; if (element.tag === 'textarea') return 'textbox'; return '';
}
function lostSemantics(before, after) {
  const oldAttributes = before.attributes; const next = after.attributes;
  const hadName = ['alt', 'aria-label', 'aria-labelledby'].some((name) => oldAttributes.has(name)); const hasName = ['alt', 'aria-label', 'aria-labelledby'].some((name) => next.has(name));
  if (hadName && !hasName) return true;
  for (const attribute of ['aria-describedby', 'aria-controls', 'for', 'htmlfor']) if (oldAttributes.has(attribute) && !next.has(attribute)) return true;
  if (oldAttributes.has('role') && !next.has('role') && oldAttributes.get('role').toLowerCase() !== implicitRole(before)) return true;
  return false;
}
export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || !input.tool_name) return block('accessibility-attribute-regression-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Write|Edit|MultiEdit)$/.test(input.tool_name)) return allow();
  if (!input.tool_input || typeof input.tool_input !== 'object' || typeof (input.tool_input.file_path || input.tool_input.file) !== 'string') return block('accessibility-attribute-regression-input-invalid', 'the file edit input is malformed');
  const file = context.file || input.tool_input.file_path || input.tool_input.file; if (!markup(file)) return allow();
  if (!context.complete) return block('accessibility-semantics-unverified', 'the markup edit could not be reconstructed');
  const before = elements(context.before || ''); const after = elements(context.proposed || '');
  for (const [identity, element] of before) if (after.has(identity) && lostSemantics(element, after.get(identity))) return block('accessibility-relationship-removed', 'the change removes an accessible name, role, or relationship from a retained element');
  return allow();
}

async function receiveEnvelope() { const chunks = []; let received = 0; for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); } try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error('hook input is not valid JSON'); } }
async function runHook() { let result; try { const input = await receiveEnvelope(); result = evaluate(input, collectContext(input)); } catch (error) { result = block('accessibility-attribute-regression-input-invalid', error.message); } if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode; }
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
