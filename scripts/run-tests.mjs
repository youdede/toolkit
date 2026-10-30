#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ROOT = path.join(ROOT, 'tests');
const MAX_TEST_FILES = 256;

export function discoverTestFiles(directory = TEST_ROOT) {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0 || files.length > MAX_TEST_FILES) {
    throw new Error(`Expected between 1 and ${MAX_TEST_FILES} test files.`);
  }
  return files;
}

export function runTests() {
  let files;
  try {
    files = discoverTestFiles();
  } catch (error) {
    process.stderr.write(`Test discovery failed: ${error.message}\n`);
    return 1;
  }
  const outcome = spawnSync(process.execPath, ['--test', ...files], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    windowsHide: true
  });
  if (outcome.error) {
    process.stderr.write(`Test execution failed before startup (${outcome.error.code ?? 'unknown'}).\n`);
    return 1;
  }
  return Number.isInteger(outcome.status) ? outcome.status : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTests();
}
