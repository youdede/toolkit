#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_PATH_BYTES = 4096;
export const MAX_SIBLINGS = 10000;
const DEVICE = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function fold(name) {
  return name.normalize('NFC').toLocaleLowerCase('en-US');
}

export function inspectPortablePath(candidate, context = {}) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return { ruleId: 'portable-path-invalid' };
  if (Buffer.byteLength(candidate) > MAX_PATH_BYTES) return { ruleId: 'portable-path-too-large' };
  if (context.exactExists) return null;
  if (context.componentCollision) return { ruleId: 'portable-name-collision' };
  const normalized = candidate.replaceAll('\\', '/');
  const components = normalized.split('/').filter((item) => item && item !== '.');
  for (const component of components) {
    if (Buffer.byteLength(component) > 255) return { ruleId: 'portable-component-too-large' };
    if (/[\u0000-\u001f<>:"|?*]/.test(component)) return { ruleId: 'portable-character-forbidden' };
    if (/[. ]$/.test(component)) return { ruleId: 'portable-trailing-character' };
    if (DEVICE.test(component)) return { ruleId: 'portable-reserved-name' };
  }
  const basename = components.at(-1);
  if (basename && Array.isArray(context.siblings)) {
    const collision = context.siblings.some((item) => item !== basename && fold(item) === fold(basename));
    if (collision) return { ruleId: 'portable-name-collision' };
  }
  return null;
}

export function collectContext(input, cwd = process.cwd()) {
  const payload = input?.tool_input || input?.toolInput || {};
  const candidate = payload.file_path || payload.file;
  if (typeof candidate !== 'string') return { relevant: true, invalid: true };
  try {
    const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
    const target = path.resolve(root, candidate);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return { relevant: false };
    const exactExists = existsSync(target);
    if (exactExists && lstatSync(target).isSymbolicLink()) return { relevant: true, invalid: true };
    let componentCollision = false;
    let cursor = root;
    let inspectedSiblings = 0;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      if (!existsSync(cursor)) break;
      const status = lstatSync(cursor);
      if (!status.isDirectory() || status.isSymbolicLink()) return { relevant: true, invalid: true };
      const entries = readdirSync(cursor);
      inspectedSiblings += entries.length;
      if (inspectedSiblings > MAX_SIBLINGS) return { relevant: true, invalid: true };
      if (!entries.includes(component) && entries.some((entry) => fold(entry) === fold(component))) componentCollision = true;
      cursor = path.join(cursor, component);
    }
    const parent = path.dirname(target);
    let siblings = [];
    if (existsSync(parent)) {
      const status = lstatSync(parent);
      if (!status.isDirectory() || status.isSymbolicLink()) return { relevant: true, invalid: true };
      siblings = readdirSync(parent);
      if (siblings.length > MAX_SIBLINGS) return { relevant: true, invalid: true };
    }
    return { relevant: true, candidate: relative, exactExists, siblings, componentCollision };
  } catch {
    return { relevant: true, invalid: true };
  }
}

export function evaluate(_input, context = {}) {
  if (!context.relevant) return { exitCode: 0 };
  if (context.invalid) return { exitCode: 2, ruleId: 'portable-path-inspection-incomplete', message: 'The requested path could not be safely inspected.' };
  const finding = inspectPortablePath(context.candidate, context);
  return finding
    ? { exitCode: 2, ruleId: finding.ruleId, message: 'The requested repository path is not portable across supported filesystems.' }
    : { exitCode: 0 };
}

async function start() {
  try {
    const buffers = []; let length = 0;
    for await (const buffer of process.stdin) {
      length += buffer.length;
      if (length > MAX_STDIN_BYTES) throw new Error('input exceeds the bounded limit');
      buffers.push(buffer);
    }
    const input = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    const outcome = evaluate(input, collectContext(input));
    if (outcome.exitCode) process.stderr.write(`[${outcome.ruleId}] ${outcome.message}\n`);
    process.exitCode = outcome.exitCode;
  } catch {
    process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
