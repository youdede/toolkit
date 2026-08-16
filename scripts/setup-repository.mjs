#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

git('rev-parse', '--git-dir');
git('config', '--local', 'core.hooksPath', '.githooks');
git('config', '--local', 'pull.ff', 'only');
git('config', '--local', 'fetch.prune', 'true');

let signingKey = '';
try {
  signingKey = git('config', '--get', 'user.signingkey');
} catch {
  // Signing remains an explicit account-level setup decision.
}

console.log('Repository-local Git policy configured:');
console.log('- core.hooksPath=.githooks');
console.log('- pull.ff=only');
console.log('- fetch.prune=true');
if (!signingKey) console.log('- signing key: not configured; add a verified SSH or GPG key before release tagging');
