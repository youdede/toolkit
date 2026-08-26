#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by authentication-accessibility-guard [' + ruleId + ']: ' + detail + '.' }; }
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
  for (const match of raw.matchAll(/\b([:@A-Za-z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\}|([^\s>]+)))?/g)) attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? match[5] ?? '');
  return attributes;
}
// A JSX expression holds '>' in every arrow function, so a tag ends at the first '>' that sits
// outside quotes and outside a braced expression. Scanning to the first '>' truncates the
// attribute region and hides the handler this guard exists to read.
function attributeRegion(source, from) {
  let depth = 0; let quote = '';
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{') { depth += 1; continue; }
    if (character === '}') { if (depth > 0) depth -= 1; continue; }
    if (depth > 0) continue;
    if (character === '<') return null;
    if (character === '>') return { raw: source.slice(from, index), end: index + 1 };
  }
  return null;
}
export function elements(text) {
  const source = text.replace(/<!--[\s\S]*?-->/g, '');
  const result = new Map(); const ordinals = new Map(); const opening = /<([A-Za-z][\w:-]*)\b/g;
  let match;
  while ((match = opening.exec(source))) {
    const region = attributeRegion(source, opening.lastIndex);
    if (!region) continue;
    opening.lastIndex = region.end;
    const tag = match[1].toLowerCase(); const attributes = parseAttributes(region.raw);
    const stable = ['id', 'data-testid', 'data-test', 'name'].find((name) => attributes.has(name) && attributes.get(name));
    const ordinal = ordinals.get(tag) || 0; ordinals.set(tag, ordinal + 1); const key = stable ? stable + ':' + attributes.get(stable) : tag + '#' + ordinal;
    result.set(key, { tag, attributes, raw: region.raw });
  }
  return result;
}

// WCAG 2.2 SC 3.3.8 concerns authentication steps. Only two markers name a credential field
// without inference: the password input type, and an autocomplete token reserved for credentials.
// A field identified by class or placeholder is a guess, so this guard leaves it alone.
const CREDENTIAL_TOKEN = /\b(?:username|current-password|new-password|one-time-code)\b/;
export function credential(element) {
  if (!element || element.tag !== 'input') return false;
  if ((element.attributes.get('type') || '').trim().toLowerCase() === 'password') return true;
  return CREDENTIAL_TOKEN.test((element.attributes.get('autocomplete') || '').toLowerCase());
}
// Tolerates one level of nested braces so a JSX block body is read, not truncated.
const PASTE_HANDLER = /\bon(?:paste|pastecapture)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\})/i;
export function pasteBlocked(element) {
  const match = (element?.raw || '').match(PASTE_HANDLER);
  if (!match) return false;
  return /preventdefault|return\s+false/i.test(match[1] ?? match[2] ?? match[3] ?? '');
}
const autocompleteOf = (element) => (element?.attributes.get('autocomplete') || '').trim().toLowerCase();
export function autofillDisabled(element) { return autocompleteOf(element) === 'off'; }
// Each password manager reads its own opt-out attribute; there is no standard one. Only names that
// state the intent in full are listed, so a generic data attribute a framework might also use is
// left out rather than guessed at.
const MANAGER_IGNORE = ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-protonpass-ignore'];
export function managerSuppressed(element) {
  return MANAGER_IGNORE.some((name) => {
    if (!element?.attributes.has(name)) return false;
    const value = element.attributes.get(name).trim().toLowerCase();
    return value !== 'false' && value !== '0';
  });
}

// A barrier is counted across the file rather than matched element by element. Identity changes
// when a field is renamed or moved, and matching per element then reads an existing barrier
// carried through that edit as a newly introduced one.
const barrierCount = (elements, test) => [...elements.values()].filter((element) => credential(element) && test(element)).length;
const BARRIERS = [
  ['credential-paste-blocked', pasteBlocked, 'the change stops paste into an authentication field, which forces the user to transcribe the secret'],
  ['credential-autofill-disabled', autofillDisabled, 'the change sets autocomplete="off" on an authentication field, which stops a password manager from filling it'],
  ['credential-manager-suppressed', managerSuppressed, 'the change adds a password-manager opt-out attribute to an authentication field, which stops the manager from filling it']
];

export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || !input.tool_name) return block('authentication-accessibility-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Write|Edit|MultiEdit)$/.test(input.tool_name)) return allow();
  if (!input.tool_input || typeof input.tool_input !== 'object' || typeof (input.tool_input.file_path || input.tool_input.file) !== 'string') return block('authentication-accessibility-input-invalid', 'the file edit input is malformed');
  const file = context.file || input.tool_input.file_path || input.tool_input.file; if (!markup(file)) return allow();
  if (!context.complete) return block('authentication-access-unverified', 'the markup edit could not be reconstructed');
  const before = elements(context.before || ''); const after = elements(context.proposed || '');

  for (const [ruleId, test, detail] of BARRIERS) if (barrierCount(after, test) > barrierCount(before, test)) return block(ruleId, detail);

  // Losing the token is pairwise by nature: it is a property of one field surviving the edit, and
  // a renamed field simply does not match, which is the conservative reading.
  for (const [identity, element] of after) {
    const previous = before.get(identity);
    if (previous && CREDENTIAL_TOKEN.test(autocompleteOf(previous)) && !CREDENTIAL_TOKEN.test(autocompleteOf(element))) return block('credential-autofill-removed', 'the change removes the autocomplete token that let a password manager recognise an authentication field');
  }
  return allow();
}

async function receiveEnvelope() { const chunks = []; let received = 0; for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); } try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error('hook input is not valid JSON'); } }
async function runHook() { let result; try { const input = await receiveEnvelope(); result = evaluate(input, collectContext(input)); } catch (error) { result = block('authentication-accessibility-input-invalid', error.message); } if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode; }
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
