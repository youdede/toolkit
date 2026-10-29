#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function cleanGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}

function git(cwd, args, required = true) {
  // Even read-only commands such as status can launch a configured fsmonitor program.
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    maxBuffer: 5 * 1024 * 1024,
    env: cleanGitEnvironment()
  });
  if (result.error || result.status !== 0) {
    if (!required) return null;
    throw new Error(String(result.stderr || result.error?.message || `git ${args[0]} failed`).trim());
  }
  return result.stdout.trimEnd();
}

export function collectGitState(cwd = process.cwd()) {
  const requested = path.resolve(cwd);
  const root = git(requested, ['rev-parse', '--show-toplevel']);
  return {
    root,
    head: git(root, ['rev-parse', 'HEAD']),
    branch: git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], false),
    upstream: git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], false),
    status: git(root, ['status', '--short', '--branch', '--untracked-files=all']),
    unstagedStat: git(root, ['diff', '--stat']),
    stagedStat: git(root, ['diff', '--cached', '--stat']),
    recentCommits: git(root, ['log', '-5', '--format=%H %s'])
  };
}

function parseCwd(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === '--cwd') return argv[1];
  throw new Error('usage: collect-git-state.mjs [--cwd <repository>]');
}

function main() {
  process.stdout.write(`${JSON.stringify(collectGitState(parseCwd(process.argv.slice(2))), null, 2)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    process.stderr.write(`collect-git-state: ${error.message}\n`);
    process.exitCode = 1;
  }
}
