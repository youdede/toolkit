#!/usr/bin/env node

// Warns before compaction when the worktree is dirty or the ledger's latest checkpoint carries
// pending claims, so context loss never silently hides unverified state. Observing only.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;

function gitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
}

export function evaluate(context) {
  const warnings = [];
  if (context?.dirtyChanges > 0) warnings.push(`${context.dirtyChanges} uncommitted change(s) will lose their pre-compaction context`);
  if (context?.pendingClaims?.length) warnings.push(`latest checkpoint has ${context.pendingClaims.length} pending claim(s): ${context.pendingClaims.join('; ')}`.slice(0, 300));
  return { exitCode: 0, warning: warnings.length ? warnings.join(' | ') : null };
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error('stdin-limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let warning = null;
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
    const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 5000,
      env: gitEnvironment()
    });
    const dirtyChanges = status.status === 0 ? status.stdout.split('\n').filter(Boolean).length : 0;
    let pendingClaims = [];
    const ledger = new URL('./lib/session-ledger.mjs', import.meta.url).pathname;
    const tail = spawnSync(process.execPath, [ledger, 'tail', '--workspace', cwd, '--n', '1'], { encoding: 'utf8', timeout: 10000 });
    if (tail.status === 0) pendingClaims = JSON.parse(tail.stdout).entries?.[0]?.pendingClaims || [];
    warning = evaluate({ dirtyChanges, pendingClaims }).warning;
  } catch {
    warning = null;
  }
  if (warning) process.stdout.write(`${JSON.stringify({ systemMessage: `Compaction readiness: ${warning}` })}\n`);
  process.exit(0);
}
