#!/usr/bin/env node

import { lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export function collectContext(input) {
  const worktree = input?.worktree_path;
  if (typeof worktree !== 'string' || !worktree) return { inspectionError: 'worktree-path-missing' };
  try {
    const metadata = lstatSync(worktree);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return { inspectionError: 'worktree-path-unsafe' };
    const resolved = realpathSync(worktree);
    const result = spawnSync('git', ['--no-optional-locks', '-C', resolved, 'status', '--porcelain=v1', '--untracked-files=all'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error || result.status !== 0) return { inspectionError: 'git-status-unavailable' };
    const changes = result.stdout.split(/\r?\n/).filter(Boolean);
    return { changeCount: changes.length };
  } catch {
    return { inspectionError: 'worktree-inspection-failed' };
  }
}

export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { exitCode: 0, ruleId: 'worktree-envelope-invalid', message: '' };
  }
  if (input.hook_event_name && input.hook_event_name !== 'WorktreeRemove') {
    return { exitCode: 0, ruleId: 'worktree-event-irrelevant', message: '' };
  }
  if (context.inspectionError) {
    return {
      exitCode: 0,
      ruleId: 'worktree-inspection-unavailable',
      message: 'OBSERVED by worktree-removal-evidence-guard [worktree-inspection-unavailable]: worktree state could not be verified before removal.'
    };
  }
  if (!Number.isInteger(context.changeCount) || context.changeCount < 0) {
    return { exitCode: 0, ruleId: 'worktree-evidence-invalid', message: '' };
  }
  if (context.changeCount > 0) {
    return {
      exitCode: 0,
      ruleId: 'worktree-dirty-observed',
      message: `OBSERVED by worktree-removal-evidence-guard [worktree-dirty-observed]: ${context.changeCount} changed worktree entr${context.changeCount === 1 ? 'y was' : 'ies were'} present before removal.`
    };
  }
  return { exitCode: 0, ruleId: 'worktree-clean-observed', message: '' };
}

async function receiveEnvelope() {
  const chunks = [];
  let received = 0;
  for await (const chunk of process.stdin) {
    received += chunk.length;
    if (received > MAX_STDIN_BYTES) throw new Error('worktree input exceeds the bounded size');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

async function runHook() {
  try {
    const input = await receiveEnvelope();
    const decision = evaluate(input, collectContext(input));
    if (decision.message) process.stderr.write(`${decision.message}\n`);
  } catch {
    process.stderr.write('OBSERVED by worktree-removal-evidence-guard [worktree-envelope-invalid]: worktree state could not be inspected.\n');
  }
  process.exitCode = 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
