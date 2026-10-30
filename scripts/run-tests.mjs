#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ROOT = path.join(ROOT, 'tests');
const MAX_TEST_FILES = 256;
// Files that compare CPU times. They run after the others, one at a time, so test files running in
// parallel do not slow one measured size more than the other.
const TIMED_FILES = new Set(['shared-hook-capability.test.mjs', 'shared-hook-items.test.mjs']);

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
  const timed = files.filter((file) => TIMED_FILES.has(path.basename(file)));
  const passes = [files.filter((file) => !timed.includes(file)), timed].filter((group) => group.length);
  let status = 0;
  for (const [index, group] of passes.entries()) {
    const concurrency = index === 0 ? [] : ['--test-concurrency=1'];
    const outcome = spawnSync(process.execPath, ['--test', ...concurrency, ...group], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false,
      windowsHide: true
    });
    if (outcome.error) {
      process.stderr.write(`Test execution failed before startup (${outcome.error.code ?? 'unknown'}).\n`);
      return 1;
    }
    if (outcome.status !== 0) status = Number.isInteger(outcome.status) ? outcome.status : 1;
  }
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTests();
}
