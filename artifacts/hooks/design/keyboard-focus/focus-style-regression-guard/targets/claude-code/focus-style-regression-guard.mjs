#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by focus-style-regression-guard [' + ruleId + ']: ' + detail + '.' }; }
function within(root, candidate) { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function nearestExistingParent(candidate) { let cursor = candidate; while (!existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) return cursor; cursor = parent; } return cursor; }
function rebuildRevision(input, before) { const tool = input?.tool_input || {}; if (typeof tool.content === 'string') return { complete: true, proposed: tool.content }; const edits = Array.isArray(tool.edits) ? tool.edits : [tool]; let proposed = before; for (const edit of edits) { if (typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string' || !edit.old_string) return { complete: false, proposed: '' }; const position = proposed.indexOf(edit.old_string); if (position < 0 || (edit.replace_all !== true && proposed.indexOf(edit.old_string, position + edit.old_string.length) >= 0)) return { complete: false, proposed: '' }; proposed = edit.replace_all === true ? proposed.split(edit.old_string).join(edit.new_string) : proposed.slice(0, position) + edit.new_string + proposed.slice(position + edit.old_string.length); } return { complete: true, proposed }; }
export function collectContext(input, cwd = process.cwd()) {
  const file = input?.tool_input?.file_path || input?.tool_input?.file || ''; if (typeof file !== 'string' || !file) return { file: '', complete: false }; const root = path.resolve(input?.cwd || cwd); const absolute = path.resolve(root, file); if (!within(root, absolute)) return { file, complete: false, inspectionError: 'path-escape' };
  try { const canonicalRoot = realpathSync(root); const boundary = realpathSync(nearestExistingParent(absolute)); if (!within(canonicalRoot, boundary)) return { file, complete: false, inspectionError: 'path-alias-escape' }; let before = ''; if (existsSync(absolute)) { const stat = lstatSync(absolute); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) return { file, complete: false, inspectionError: 'unsafe-target' }; before = readFileSync(absolute, 'utf8'); } return { file, before, ...rebuildRevision(input, before) }; } catch { return { file, complete: false, inspectionError: 'read-failed' }; }
}

function cssFile(file) { return /\.(?:css|scss|sass|less|styl)$/i.test(file); }
function normalizedSelector(selector) { return selector.replace(/\s+/g, ' ').trim(); }
function focusStates(text) {
  const states = new Map(); const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map(normalizedSelector).filter((selector) => /:focus(?:-visible|-within)?\b/i.test(selector)); if (!selectors.length) continue;
    const declarations = [...match[2].matchAll(/([\w-]+)\s*:\s*([^;!]+)(?:!important)?\s*(?:;|$)/g)].map((entry) => [entry[1].toLowerCase(), entry[2].trim().toLowerCase()]);
    for (const selector of selectors) { const state = states.get(selector) || new Map(); for (const [property, value] of declarations) state.set(property, value); states.set(selector, state); }
  }
  return states;
}
function invisible(state) {
  const outline = state.get('outline') || ''; const outlineWidth = state.get('outline-width') || ''; const disabled = /^(?:none|0(?:\D|$))/.test(outline) || /^0(?:\D|$)/.test(outlineWidth); if (!disabled) return false;
  const visible = [...state].some(([property, value]) => /^(?:box-shadow|border(?:-color|-width|-style)?|text-decoration|background(?:-color)?|filter)$/.test(property) && !/^(?:none|transparent|0(?:\D|$)|initial|inherit|unset)$/.test(value));
  return !visible;
}
export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || !input.tool_name) return block('focus-style-regression-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Write|Edit|MultiEdit)$/.test(input.tool_name)) return allow();
  if (!input.tool_input || typeof input.tool_input !== 'object' || typeof (input.tool_input.file_path || input.tool_input.file) !== 'string') return block('focus-style-regression-input-invalid', 'the file edit input is malformed');
  const file = context.file || input.tool_input.file_path || input.tool_input.file; if (!cssFile(file)) return allow();
  if (!context.complete) return block('focus-style-unverified', 'the stylesheet edit could not be reconstructed');
  const before = focusStates(context.before || ''); const after = focusStates(context.proposed || '');
  for (const [selector, state] of after) if (invisible(state) && !invisible(before.get(selector) || new Map())) return block('focus-indicator-removed', 'a focus selector disables its indicator without a visible replacement');
  return allow();
}

async function receiveEnvelope() { const chunks = []; let received = 0; for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); } try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error('hook input is not valid JSON'); } }
async function runHook() { let result; try { const input = await receiveEnvelope(); result = evaluate(input, collectContext(input)); } catch (error) { result = block('focus-style-regression-input-invalid', error.message); } if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode; }
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
