#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_PACKAGE_BYTES = 384 * 1024;
const LIFECYCLES = new Set(['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare', 'prepublish', 'prepublishOnly', 'dependencies', 'pnpm:devPreinstall']);

function packagePath(candidate) {
  return typeof candidate === 'string' && !candidate.includes('\0') && /(?:^|[\\/])package\.json$/i.test(candidate);
}

export function lifecycleEntries(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_PACKAGE_BYTES) throw new Error('package manifest exceeds bounds');
  let document;
  try { document = JSON.parse(source); } catch { throw new Error('package manifest is malformed'); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('package manifest must be an object');
  if (document.scripts === undefined) return [];
  if (!document.scripts || typeof document.scripts !== 'object' || Array.isArray(document.scripts)) throw new Error('scripts must be an object');
  return Object.keys(document.scripts)
    .filter((key) => LIFECYCLES.has(key) && typeof document.scripts[key] === 'string' && document.scripts[key].trim())
    .sort();
}

function lifecycleMap(source) {
  const entries = lifecycleEntries(source);
  const document = JSON.parse(source);
  return new Map(entries.map((key) => [key, document.scripts[key].trim()]));
}

function replaceExactly(text, operation) {
  if (typeof operation?.old_string !== 'string' || operation.old_string.length === 0 || typeof operation?.new_string !== 'string') {
    throw new Error('edit operation is incomplete');
  }
  const count = text.split(operation.old_string).length - 1;
  if (operation.replace_all === true) {
    if (count === 0) throw new Error('old text is absent');
    return text.split(operation.old_string).join(operation.new_string);
  }
  if (count !== 1) throw new Error('old text must occur exactly once');
  return text.replace(operation.old_string, operation.new_string);
}

function materialize(current, payload) {
  if (typeof payload.content === 'string') return payload.content;
  let result = current;
  for (const operation of Array.isArray(payload.edits) ? payload.edits : [payload]) result = replaceExactly(result, operation);
  return result;
}

export function collectContext(input, cwd = process.cwd()) {
  const payload = input?.tool_input || input?.toolInput || {};
  const namedPath = payload.file_path || payload.file;
  if (!packagePath(namedPath)) return { relevant: false };
  try {
    const root = realpathSync(path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd));
    const target = path.resolve(root, namedPath);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('outside project');
    let cursor = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (!existsSync(cursor)) break;
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('package path traverses a symlink');
    }
    let oldText = '{}';
    try {
      const status = lstatSync(target);
      if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_PACKAGE_BYTES) throw new Error('unsafe package path');
      oldText = readFileSync(target, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { relevant: true, oldText, newText: materialize(oldText === '{}' ? '' : oldText, payload) };
  } catch {
    return { relevant: true, error: true };
  }
}

export function evaluate(_input, snapshot = {}) {
  if (!snapshot.relevant) return { exitCode: 0 };
  if (snapshot.error) return { exitCode: 2, ruleId: 'lifecycle-script-inspection-incomplete', message: 'The complete package manifest could not be reconstructed.' };
  try {
    const prior = lifecycleMap(snapshot.oldText);
    const addition = [...lifecycleMap(snapshot.newText)].find(([entry, command]) => !prior.has(entry) || prior.get(entry) !== command);
    if (!addition) return { exitCode: 0 };
    return { exitCode: 2, ruleId: 'install-lifecycle-script-introduced', message: 'The package change introduces automatic install-time lifecycle execution.' };
  } catch {
    return { exitCode: 2, ruleId: 'lifecycle-script-input-invalid', message: 'Lifecycle-script inspection received malformed or oversized package metadata.' };
  }
}

async function main() {
  try {
    const received = []; let bytes = 0;
    for await (const part of process.stdin) {
      bytes += part.length;
      if (bytes > MAX_STDIN_BYTES) throw new Error('input exceeds the bounded limit');
      received.push(part);
    }
    const envelope = JSON.parse(Buffer.concat(received).toString('utf8'));
    const decision = evaluate(envelope, collectContext(envelope));
    if (decision.exitCode) process.stderr.write(`[${decision.ruleId}] ${decision.message}\n`);
    process.exitCode = decision.exitCode;
  } catch {
    process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
