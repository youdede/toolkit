#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const METHODS = /^(?:get|put|post|delete|patch|head|options|trace)$/i;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by api-contract-compatibility-guard [' + ruleId + ']: ' + detail + '.' }; }
function within(root, candidate) { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
function nearestExistingParent(candidate) { let cursor = candidate; while (!existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) return cursor; cursor = parent; } return cursor; }
function rebuildRevision(input, before) {
  const tool = input?.tool_input || {};
  if (typeof tool.content === 'string') return { complete: true, proposed: tool.content };
  const edits = Array.isArray(tool.edits) ? tool.edits : [tool]; let proposed = before;
  for (const edit of edits) {
    if (typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string' || !edit.old_string) return { complete: false, proposed: '' };
    const position = proposed.indexOf(edit.old_string);
    if (position < 0 || (edit.replace_all !== true && proposed.indexOf(edit.old_string, position + edit.old_string.length) >= 0)) return { complete: false, proposed: '' };
    proposed = edit.replace_all === true ? proposed.split(edit.old_string).join(edit.new_string) : proposed.slice(0, position) + edit.new_string + proposed.slice(position + edit.old_string.length);
  }
  return { complete: true, proposed };
}
export function collectContext(input, cwd = process.cwd()) {
  const file = input?.tool_input?.file_path || input?.tool_input?.file || '';
  if (typeof file !== 'string' || !file) return { file: '', complete: false };
  const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd); const absolute = path.resolve(root, file);
  if (!within(root, absolute)) return { file, complete: false, inspectionError: 'path-escape' };
  try {
    const canonicalRoot = realpathSync(root); const boundary = realpathSync(nearestExistingParent(absolute));
    if (!within(canonicalRoot, boundary)) return { file, complete: false, inspectionError: 'path-alias-escape' };
    let before = '';
    if (existsSync(absolute)) { const stat = lstatSync(absolute); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) return { file, complete: false, inspectionError: 'unsafe-target' }; before = readFileSync(absolute, 'utf8'); }
    return { file, before, ...rebuildRevision(input, before) };
  } catch { return { file, complete: false, inspectionError: 'read-failed' }; }
}

function operationKey(method, route) { return method.toLowerCase() + ':' + route; }
function createOperation() { return { responses: new Set(), required: new Set(), requestBodyRequired: false }; }
function jsonModel(text) {
  const root = JSON.parse(text); const operations = new Map();
  if (!root || typeof root !== 'object' || !root.paths || typeof root.paths !== 'object') throw new Error('paths-missing');
  for (const [route, item] of Object.entries(root.paths)) {
    const pathParameters = Array.isArray(item?.parameters) ? item.parameters : [];
    for (const [method, operation] of Object.entries(item || {})) {
      if (!METHODS.test(method) || !operation || typeof operation !== 'object') continue;
      const model = createOperation();
      for (const code of Object.keys(operation.responses || {})) model.responses.add(code);
      for (const parameter of [...pathParameters, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
        if (parameter?.required === true && typeof parameter.name === 'string' && typeof parameter.in === 'string') model.required.add(parameter.in + ':' + parameter.name);
      }
      model.requestBodyRequired = operation.requestBody?.required === true;
      operations.set(operationKey(method, route), model);
    }
  }
  return { operations, declared: typeof root.openapi === 'string' || typeof root.swagger === 'string' };
}
function yamlModel(text) {
  const operations = new Map(); const lines = text.split(/\r?\n/); let route = ''; let routeIndent = -1; let operation = null; let operationIndent = -1; let section = ''; let sectionIndent = -1; let parameter = null;
  const finishParameter = () => { if (parameter?.required && parameter.name && parameter.location && operation) operation.required.add(parameter.location + ':' + parameter.name); parameter = null; };
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, ''); if (!line.trim()) continue;
    const indent = /^\s*/.exec(line)[0].replace(/\t/g, '  ').length; const content = line.trim();
    const routeMatch = /^(['"]?)(\/[^:'"]+)\1:\s*$/.exec(content);
    if (routeMatch) { finishParameter(); route = routeMatch[2]; routeIndent = indent; operation = null; section = ''; continue; }
    if (route && indent <= routeIndent) { finishParameter(); route = ''; operation = null; section = ''; }
    const methodMatch = /^([A-Za-z]+):\s*$/.exec(content);
    if (route && methodMatch && METHODS.test(methodMatch[1]) && indent > routeIndent) {
      finishParameter(); operation = createOperation(); operationIndent = indent; operations.set(operationKey(methodMatch[1], route), operation); section = ''; continue;
    }
    if (!operation || indent <= operationIndent) continue;
    if (/^responses:\s*$/.test(content)) { finishParameter(); section = 'responses'; sectionIndent = indent; continue; }
    if (/^parameters:\s*$/.test(content)) { finishParameter(); section = 'parameters'; sectionIndent = indent; continue; }
    if (/^requestBody:\s*$/.test(content)) { finishParameter(); section = 'requestBody'; sectionIndent = indent; continue; }
    if (indent <= sectionIndent) { finishParameter(); section = ''; }
    if (section === 'responses') { const match = /^['"]?([1-5][0-9Xx]{2}|default)['"]?:/.exec(content); if (match) operation.responses.add(match[1]); }
    if (section === 'requestBody' && /^required:\s*true\s*$/i.test(content)) operation.requestBodyRequired = true;
    if (section === 'parameters') {
      const name = /^-\s*name:\s*['"]?([^'"]+)['"]?\s*$/.exec(content);
      if (name) { finishParameter(); parameter = { name: name[1].trim(), location: '', required: false }; continue; }
      if (parameter) {
        const location = /^in:\s*['"]?([^'"]+)['"]?\s*$/.exec(content); if (location) parameter.location = location[1].trim();
        if (/^required:\s*true\s*$/i.test(content)) parameter.required = true;
      }
    }
  }
  finishParameter();
  return { operations, declared: /^\s*(?:openapi|swagger):\s*['"]?\d/m.test(text) };
}
function contractModel(text, file) {
  if (/\.json$/i.test(file) || /^\s*[\[{]/.test(text)) return jsonModel(text);
  return yamlModel(text);
}
function namedContract(file) { return /(?:^|\/)(?:openapi|swagger)(?:[._-][^/]*)?\.(?:json|ya?ml)$/i.test(file); }
export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || !input.tool_name) return block('api-contract-compatibility-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Write|Edit|MultiEdit)$/.test(input.tool_name)) return allow();
  if (!input.tool_input || typeof input.tool_input !== 'object' || typeof (input.tool_input.file_path || input.tool_input.file) !== 'string') return block('api-contract-compatibility-input-invalid', 'the file edit input is malformed');
  const file = context.file || input.tool_input.file_path || input.tool_input.file; const candidate = /\.(?:json|ya?ml)$/i.test(file);
  if (!candidate) return allow();
  if (!context.complete) return namedContract(file) ? block('api-contract-unverified', 'the API contract edit could not be reconstructed') : allow();
  if (!context.before) return allow();
  let oldModel; let newModel;
  try { oldModel = contractModel(context.before || '', file); newModel = contractModel(context.proposed || '', file); }
  catch { return namedContract(file) ? block('api-contract-unverified', 'the API contract cannot be parsed deterministically') : allow(); }
  if (!namedContract(file) && !oldModel.declared && !newModel.declared) return allow();
  for (const [key, oldOperation] of oldModel.operations) {
    const next = newModel.operations.get(key);
    if (!next) return block('api-contract-element-removed', 'the proposed API contract removes an operation');
    for (const response of oldOperation.responses) if (!next.responses.has(response)) return block('api-contract-element-removed', 'the proposed API contract removes a response guarantee');
    for (const required of next.required) if (!oldOperation.required.has(required)) return block('api-required-input-added', 'the proposed API contract adds or strengthens a mandatory parameter');
    if (!oldOperation.requestBodyRequired && next.requestBodyRequired) return block('api-required-input-added', 'the proposed API contract makes the request body mandatory');
  }
  return allow();
}

async function receiveEnvelope() {
  const chunks = []; let received = 0;
  for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); }
  try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error('hook input is not valid JSON'); }
}
async function runHook() { let result; try { const input = await receiveEnvelope(); result = evaluate(input, collectContext(input)); } catch (error) { result = block('api-contract-compatibility-input-invalid', error.message); } if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode; }
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
