#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_MANIFEST_BYTES = 384 * 1024;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function isPackageManifest(value) {
  return typeof value === 'string' && !value.includes('\0') && /(?:^|\/)package\.json$/i.test(value.replaceAll('\\', '/'));
}

function sourceType(specifier) {
  const value = specifier.trim();
  if (/^(?:git(?:\+[^:]+)?|github|gitlab|bitbucket):/i.test(value) || /^git@[^:]+:/i.test(value)) return 'git-source';
  if (/^(?:https?|ftp):/i.test(value)) return 'remote-archive';
  if (/^(?:file|link|workspace|portal|patch):/i.test(value) || /^(?:\.{1,2}[\\/]|~[\\/]|[/\\])/.test(value)) return 'local-or-virtual-source';
  if (/^npm:/i.test(value)) return 'registry-alias';
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.*)?$/.test(value)) return 'repository-shorthand';
  if (/[\0\r\n]/.test(value) || value.includes('${')) return 'dynamic-source';
  return null;
}

export function scanDependencySources(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_MANIFEST_BYTES) throw new Error('manifest content is invalid or oversized');
  let manifest;
  try { manifest = JSON.parse(content); } catch { throw new Error('manifest is not valid JSON'); }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') throw new Error('manifest root is not an object');
  const findings = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!dependencies || Array.isArray(dependencies) || typeof dependencies !== 'object') throw new Error(`${field} must be an object`);
    for (const name of Object.keys(dependencies).sort()) {
      const specifier = dependencies[name];
      if (typeof specifier !== 'string') throw new Error('dependency specifier must be text');
      const type = sourceType(specifier);
      // The specifier is part of the identity: moving an existing source elsewhere is a new source.
      if (type) findings.push({ ruleId: 'dependency-source-bypass', identity: `${field}:${name}:${type}:${specifier.trim()}` });
    }
  }
  const visitOverride = (value, location, depth = 0) => {
    if (depth > 32) throw new Error('override nesting exceeds bounds');
    if (typeof value === 'string') {
      const type = sourceType(value);
      if (type) findings.push({ ruleId: 'dependency-source-bypass', identity: `${location}:${type}:${value}` });
      return;
    }
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('override value is invalid');
    for (const key of Object.keys(value).sort()) visitOverride(value[key], `${location}.${key}`, depth + 1);
  };
  for (const field of ['overrides', 'resolutions']) if (manifest[field] !== undefined) visitOverride(manifest[field], field);
  if (manifest.pnpm?.overrides !== undefined) visitOverride(manifest.pnpm.overrides, 'pnpm.overrides');
  return findings;
}

function applyMutation(original, payload) {
  if (typeof payload?.content === 'string') return payload.content;
  const edits = Array.isArray(payload?.edits) ? payload.edits : [payload];
  let current = original;
  for (const edit of edits) {
    if (typeof edit?.old_string !== 'string' || !edit.old_string || typeof edit?.new_string !== 'string') throw new Error('edit is incomplete');
    const split = current.split(edit.old_string);
    if (edit.replace_all === true) {
      if (split.length === 1) throw new Error('edit source is absent');
      current = split.join(edit.new_string);
    } else {
      if (split.length !== 2) throw new Error('edit source is not unique');
      current = split.join(edit.new_string);
    }
  }
  return current;
}

export function collectContext(input, options = {}) {
  const payload = input?.tool_input || input?.toolInput || {};
  const requested = payload.file_path || payload.file;
  if (!isPackageManifest(requested)) return { relevant: false };
  try {
    // An absolute path may name the project through a symlink (/var and /private/var on macOS), so
    // it is compared with the project path as given and with its real path.
    const lexical = path.resolve(options.cwd || process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd());
    const root = realpathSync(lexical);
    const relative = [lexical, root].map((base) => path.relative(base, path.resolve(base, requested)))
      .find((candidate) => candidate !== '..' && !candidate.startsWith(`..${path.sep}`) && !path.isAbsolute(candidate));
    if (relative === undefined) throw new Error('manifest leaves project');
    const target = path.join(root, relative);
    let cursor = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (!existsSync(cursor)) break;
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('manifest path traverses a symlink');
    }
    let original = '';
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) throw new Error('manifest target cannot be inspected');
      original = readFileSync(target, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { relevant: true, before: original || '{}', after: applyMutation(original, payload) };
  } catch {
    return { relevant: true, invalid: true };
  }
}

export function evaluate(_input, evidence = {}) {
  if (!evidence.relevant) return { exitCode: 0 };
  if (evidence.invalid) return { exitCode: 2, ruleId: 'dependency-source-inspection-incomplete', message: 'The complete dependency manifest could not be inspected.' };
  try {
    const previous = new Set(scanDependencySources(evidence.before).map((item) => item.identity));
    const introduced = scanDependencySources(evidence.after).find((item) => !previous.has(item.identity));
    return introduced
      ? { exitCode: 2, ruleId: introduced.ruleId, message: 'The change introduces a dependency source outside ordinary registry resolution.' }
      : { exitCode: 0 };
  } catch {
    return { exitCode: 2, ruleId: 'dependency-source-input-invalid', message: 'Dependency source inspection received malformed or oversized manifest content.' };
  }
}

async function run() {
  try {
    const chunks = []; let total = 0;
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_STDIN_BYTES) throw new Error('input exceeds the bounded limit');
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = evaluate(input, collectContext(input));
    if (result.exitCode) process.stderr.write(`[${result.ruleId}] ${result.message}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) run();
