#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by schema-compatibility-guard [' + ruleId + ']: ' + detail + '.' }; }


const MAX_TEXT_BYTES = 512 * 1024;
function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function nearestExistingParent(candidate) {
  let cursor = candidate;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  return cursor;
}
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
    const canonicalRoot = realpathSync(root);
    const resolvedBoundary = realpathSync(nearestExistingParent(absolute));
    if (!within(canonicalRoot, resolvedBoundary)) return { file, complete: false, inspectionError: 'path-alias-escape' };
    let before = '';
    if (existsSync(absolute)) {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) return { file, complete: false, inspectionError: 'unsafe-target' };
      before = readFileSync(absolute, 'utf8');
    }
    return { file, before, ...rebuildRevision(input, before) };
  } catch { return { file, complete: false, inspectionError: 'read-failed' }; }
}


function schemaKind(file) {
  if (/\.proto$/i.test(file)) return 'proto';
  if (/\.avsc$/i.test(file)) return 'avro';
  if (/\.schema\.json$/i.test(file)) return 'json-schema';
  return null;
}
function typeSet(value) {
  if (value === undefined) return null;
  const values = Array.isArray(value) ? value : [value];
  return new Set(values.map((entry) => JSON.stringify(entry)));
}
function lostAllowedTypes(before, after) {
  const oldTypes = typeSet(before); const newTypes = typeSet(after);
  if (oldTypes === null) return newTypes !== null;
  if (newTypes === null) return false;
  return [...oldTypes].some((entry) => !newTypes.has(entry));
}
function jsonIssues(before, after, issues = []) {
  if (!before || typeof before !== 'object' || !after || typeof after !== 'object') return issues;
  if (lostAllowedTypes(before.type, after.type)) issues.push('type-narrowed');
  if (Array.isArray(before.enum)) {
    const next = new Set(Array.isArray(after.enum) ? after.enum.map((entry) => JSON.stringify(entry)) : before.enum.map((entry) => JSON.stringify(entry)));
    if (Array.isArray(after.enum) && before.enum.some((entry) => !next.has(JSON.stringify(entry)))) issues.push('enum-value-removed');
  }
  if (before.additionalProperties !== false && after.additionalProperties === false) issues.push('additional-properties-closed');
  for (const key of ['properties', '$defs', 'definitions', 'patternProperties']) {
    const oldEntries = before[key] && typeof before[key] === 'object' ? before[key] : {};
    const newEntries = after[key] && typeof after[key] === 'object' ? after[key] : {};
    for (const name of Object.keys(oldEntries)) {
      if (!Object.hasOwn(newEntries, name)) issues.push(`${key}-entry-removed`);
      else jsonIssues(oldEntries[name], newEntries[name], issues);
    }
  }
  const oldRequired = new Set(Array.isArray(before.required) ? before.required : []);
  for (const key of Array.isArray(after.required) ? after.required : []) if (!oldRequired.has(key)) issues.push('required-field-added');
  if (before.items && after.items) jsonIssues(before.items, after.items, issues);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(before[key]) && Array.isArray(after[key])) {
      if (after[key].length < before[key].length) issues.push(`${key}-branch-removed`);
      for (let index = 0; index < Math.min(before[key].length, after[key].length); index += 1) jsonIssues(before[key][index], after[key][index], issues);
    }
  }
  return issues;
}
function avroIssues(before, after, issues = []) {
  const oldFields = Array.isArray(before?.fields) ? Object.fromEntries(before.fields.map((field) => [field.name, field])) : {};
  const newFields = Array.isArray(after?.fields) ? Object.fromEntries(after.fields.map((field) => [field.name, field])) : {};
  for (const [name, field] of Object.entries(oldFields)) {
    if (!Object.hasOwn(newFields, name)) { issues.push('field-removed'); continue; }
    if (lostAllowedTypes(field.type, newFields[name].type)) issues.push('field-type-narrowed');
    const oldNested = Array.isArray(field.type) ? field.type.find((entry) => entry && typeof entry === 'object' && entry.type === 'record') : field.type;
    const newType = newFields[name].type;
    const newNested = Array.isArray(newType) ? newType.find((entry) => entry && typeof entry === 'object' && entry.type === 'record') : newType;
    if (oldNested?.fields && newNested?.fields) avroIssues(oldNested, newNested, issues);
  }
  return issues;
}
function declaredJsonSchema(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.$schema === 'string' && /json-schema/i.test(parsed.$schema);
  } catch { return false; }
}
function stripProtoComments(text) { return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' '); }
function protoFields(text) {
  const fields = new Map(); const stack = []; let invalid = false; const source = stripProtoComments(text);
  const tokens = /\bmessage\s+([A-Za-z_]\w*)\s*\{|(?:optional\s+|required\s+|repeated\s+)?(map\s*<[^>]+>|[A-Za-z_][\w.]*)\s+([A-Za-z_]\w*)\s*=\s*(\d+)(?:\s*\[[^\]]*\])?\s*;|[{}]/g;
  for (const token of source.matchAll(tokens)) {
    if (token[1]) { stack.push(token[1]); continue; }
    if (token[2]) {
      const scope = stack.filter(Boolean).join('.'); if (!scope) continue; const key = `${scope}:${token[4]}`;
      if (fields.has(key)) invalid = true; else fields.set(key, `${token[2].replace(/\s+/g, '')}:${token[3]}`);
      continue;
    }
    if (token[0] === '{') stack.push(null);
    else if (!stack.length) invalid = true; else stack.pop();
  }
  if (stack.length) invalid = true;
  return { fields, invalid };
}
function jsonDocumentIssues(kind, beforeText, afterText) {
  const issues = [];
  const before = JSON.parse(beforeText); const after = JSON.parse(afterText);
  return kind === 'avro' ? avroIssues(before, after, issues) : jsonIssues(before, after, issues);
}
export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || !input.tool_name) return block('schema-compatibility-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Write|Edit|MultiEdit)$/.test(input.tool_name)) return allow();
  if (!input.tool_input || typeof input.tool_input !== 'object' || typeof (input.tool_input.file_path || input.tool_input.file) !== 'string') return block('schema-compatibility-input-invalid', 'the file edit input is malformed');
  let kind = schemaKind(context.file || input.tool_input.file_path || input.tool_input.file || '');
  if (!kind && /\.json$/i.test(context.file || input.tool_input.file_path || '') && (declaredJsonSchema(context.before) || declaredJsonSchema(context.proposed))) kind = 'json-schema';
  if (!kind) return allow();
  if (!context.complete) return block('schema-compatibility-unverified', 'the schema edit could not be reconstructed safely');
  if (!context.before) return allow();
  if (kind === 'proto') {
    const oldModel = protoFields(context.before); const nextModel = protoFields(context.proposed);
    if (oldModel.invalid || nextModel.invalid) return block('schema-compatibility-unverified', 'the Protobuf message structure is not statically balanced');
    for (const [identityKey, identity] of oldModel.fields) if (!nextModel.fields.has(identityKey) || nextModel.fields.get(identityKey) !== identity) return block('protobuf-field-identity-changed', 'a Protobuf field number was removed or reused within its message');
    return allow();
  }
  try {
    const issues = jsonDocumentIssues(kind, context.before, context.proposed);
    return issues.length ? block('schema-breaking-change', 'the proposed schema removes or narrows a published field contract') : allow();
  } catch { return block('schema-compatibility-unverified', 'the schema document is not valid bounded JSON'); }
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
  catch (error) { result = block('schema-compatibility-input-invalid', error.message); }
  if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
