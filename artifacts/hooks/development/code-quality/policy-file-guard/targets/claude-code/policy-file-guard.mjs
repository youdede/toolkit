#!/usr/bin/env node

import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;

const DEFAULT_PROTECTED_BASENAMES = new Set([
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  'prettier.config.js',
  'prettier.config.mjs',
  'prettier.config.cjs',
  'biome.json',
  'biome.jsonc',
  'ruff.toml',
  '.ruff.toml',
  '.shellcheckrc',
  'codeowners'
]);

function normalizeRelative(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function existing(target) {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return true;
  }
}

export function evaluate(input, cwd = process.cwd()) {
  const rawPath = input?.tool_input?.file_path || input?.tool_input?.file;
  if (!rawPath || typeof rawPath !== 'string') return { exitCode: 0, message: '' };

  const projectRoot = path.resolve(input?.cwd || cwd);
  const target = path.resolve(projectRoot, rawPath);
  const relative = normalizeRelative(path.relative(projectRoot, target));
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    return { exitCode: 0, message: '' };
  }

  const base = path.basename(target).toLowerCase();
  const protectedPath = DEFAULT_PROTECTED_BASENAMES.has(base)
    || relative.toLowerCase() === '.github/dependabot.yml'
    || relative.toLowerCase() === '.github/codeowners';

  if (!protectedPath || !existing(target)) return { exitCode: 0, message: '' };
  return {
    exitCode: 2,
    message: `BLOCKED by policy-file-guard: ${relative} is an existing quality or ownership policy. Fix the source that violates it; any intentional policy change must be made by a person outside the guarded agent session.`
  };
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error(`hook input exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error(`hook input is not valid JSON: ${error.message}`);
  }
}

async function main() {
  let result;
  try {
    result = evaluate(await readInput());
  } catch (error) {
    result = { exitCode: 2, message: `BLOCKED by policy-file-guard: ${error.message}.` };
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
