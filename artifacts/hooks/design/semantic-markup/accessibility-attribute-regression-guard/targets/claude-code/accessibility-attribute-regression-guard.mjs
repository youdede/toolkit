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
  const file = input?.tool_input?.file_path || input?.tool_input?.file || ''; if (typeof file !== 'string' || !file) return { file: '', complete: false }; const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd); const absolute = path.resolve(root, file); if (!within(root, absolute)) return { file, complete: false, inspectionError: 'path-escape' };
  try { const canonicalRoot = realpathSync(root); const boundary = realpathSync(nearestExistingParent(absolute)); if (!within(canonicalRoot, boundary)) return { file, complete: false, inspectionError: 'path-alias-escape' }; let before = ''; if (existsSync(absolute)) { const stat = lstatSync(absolute); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) return { file, complete: false, inspectionError: 'unsafe-target' }; before = readFileSync(absolute, 'utf8'); } return { file, before, ...rebuildRevision(input, before) }; } catch { return { file, complete: false, inspectionError: 'read-failed' }; }
}

function markup(file) { return /\.(?:html?|jsx|tsx|vue|svelte)$/i.test(file); }
function parseAttributes(raw) {
  const attributes = new Map();
  for (const match of raw.matchAll(/\b([:@A-Za-z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\}|([^\s>]+)))?/g)) attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? match[5] ?? '');
  return attributes;
}
// Every JSX arrow function carries a '>', so a tag ends at the first '>' outside quotes and outside
// a braced expression. Ending it at the first '>' truncated the tag mid-attribute and hid every
// name, role, and relationship written after a handler.
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
function elements(text) {
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
    result.set(key, { tag, attributes, stable: Boolean(stable) });
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
// "Do not use role='presentation' or aria-hidden='true' on a focusable element." (W3C, Using ARIA.)
// The element keeps taking keyboard focus while the accessibility tree says nothing is there, so a
// screen reader user lands on silence. Only the element itself is judged: this parser is flat, so a
// focusable child inside a hidden wrapper is beyond its reach and is left to human review.
const NATIVELY_FOCUSABLE = /^(?:button|select|textarea|iframe|summary)$/;
function focusable(element) {
  const tabindex = Number.parseInt(element.attributes.get('tabindex') ?? '', 10);
  if (Number.isFinite(tabindex)) return tabindex >= 0;
  if (element.attributes.has('disabled')) return false;
  if (element.tag === 'a' || element.tag === 'area') return element.attributes.has('href');
  if (element.tag === 'input') return (element.attributes.get('type') || '').trim().toLowerCase() !== 'hidden';
  return NATIVELY_FOCUSABLE.test(element.tag);
}
function hiddenFromAssistiveTechnology(element) {
  if ((element.attributes.get('aria-hidden') || '').trim().toLowerCase() === 'true') return true;
  const role = (element.attributes.get('role') || '').trim().toLowerCase();
  return role === 'presentation' || role === 'none';
}
// Counted across the file: an element that is renamed or moved keeps no identity, and pairing by
// identity would read a pre-existing pairing as one this edit introduced.
const silentlyFocusable = (map) => [...map.values()].filter((element) => focusable(element) && hiddenFromAssistiveTechnology(element)).length;

// W3C ACT rule b4f0c3, "Meta viewport allows for zoom": a viewport meta element's content may not
// set user-scalable to no, nor maximum-scale below 2. The rule is required for WCAG SC 1.4.4 Resize
// text at Level AA. It reads one attribute value, so it belongs beside the other attribute checks
// rather than in a fourth process spawned on every file edit.
const MINIMUM_MAXIMUM_SCALE = 2;
export function zoomSuppressed(element) {
  if (element.tag !== 'meta' || (element.attributes.get('name') || '').trim().toLowerCase() !== 'viewport') return false;
  const content = element.attributes.get('content');
  // A value the page computes at runtime cannot be read here, so it is left alone.
  if (typeof content !== 'string' || !content.trim()) return false;
  const properties = new Map();
  for (const pair of content.split(',')) {
    const [name, ...rest] = pair.split('=');
    if (rest.length) properties.set(name.trim().toLowerCase(), rest.join('=').trim().toLowerCase());
  }
  const scalable = properties.get('user-scalable');
  // The rule names "no"; the numeric spelling disables zoom identically and is treated the same.
  if (scalable === 'no' || scalable === '0') return true;
  const maximum = Number.parseFloat(properties.get('maximum-scale'));
  return Number.isFinite(maximum) && maximum < MINIMUM_MAXIMUM_SCALE;
}
const suppressedZoom = (map) => [...map.values()].filter(zoomSuppressed).length;

// An element with no id, test id or name is identified only by its position among its siblings of
// the same tag, and inserting one earlier shifts every position after it. Comparing those pairwise
// would read an added button as an edit that stripped the next button's relationships. Positional
// elements are therefore judged by how many of them still carry a name or a relationship, which
// still falls when one is stripped and does not move when one is added.
const NAMES = ['alt', 'aria-label', 'aria-labelledby'];
const RELATIONSHIPS = ['aria-describedby', 'aria-controls', 'for', 'htmlfor'];
function positionalCounts(map) {
  const counts = new Map();
  for (const element of map.values()) {
    if (element.stable) continue;
    const bump = (suffix) => counts.set(`${element.tag}:${suffix}`, (counts.get(`${element.tag}:${suffix}`) || 0) + 1);
    if (NAMES.some((name) => element.attributes.has(name))) bump('name');
    for (const attribute of RELATIONSHIPS) if (element.attributes.has(attribute)) bump(attribute);
    if (element.attributes.has('role') && element.attributes.get('role').toLowerCase() !== implicitRole(element)) bump('role');
  }
  return counts;
}

export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || !input.tool_name) return block('accessibility-attribute-regression-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Write|Edit|MultiEdit)$/.test(input.tool_name)) return allow();
  if (!input.tool_input || typeof input.tool_input !== 'object' || typeof (input.tool_input.file_path || input.tool_input.file) !== 'string') return block('accessibility-attribute-regression-input-invalid', 'the file edit input is malformed');
  const file = context.file || input.tool_input.file_path || input.tool_input.file; if (!markup(file)) return allow();
  if (!context.complete) return block('accessibility-semantics-unverified', 'the markup edit could not be reconstructed');
  const before = elements(context.before || ''); const after = elements(context.proposed || '');
  for (const [identity, element] of before) {
    if (!element.stable) continue;
    if (after.has(identity) && lostSemantics(element, after.get(identity))) return block('accessibility-relationship-removed', 'the change removes an accessible name, role, or relationship from a retained element');
  }
  const carriedBefore = positionalCounts(before); const carriedAfter = positionalCounts(after);
  for (const [what, count] of carriedBefore) {
    if ((carriedAfter.get(what) || 0) < count) return block('accessibility-relationship-removed', 'the change leaves fewer elements carrying an accessible name, role, or relationship than it found');
  }
  if (silentlyFocusable(after) > silentlyFocusable(before)) return block('accessibility-hidden-focusable', 'the change hides an element from assistive technology while it still takes keyboard focus, so a screen reader user reaches it and hears nothing');
  if (suppressedZoom(after) > suppressedZoom(before)) return block('viewport-zoom-suppressed', 'the change stops the browser zooming, which the user needs to read the page at a size they can see');
  return allow();
}

async function receiveEnvelope() { const chunks = []; let received = 0; for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); } try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error('hook input is not valid JSON'); } }
async function runHook() { let result; try { const input = await receiveEnvelope(); result = evaluate(input, collectContext(input)); } catch (error) { result = block('accessibility-attribute-regression-input-invalid', error.message); } if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode; }
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
