#!/usr/bin/env node

// Reads the session ledger tail at session start and injects a bounded, integrity-flagged summary
// as additional context. Never blocks; a missing, malformed, or tampered ledger degrades to a
// shorter, explicitly marked context instead of an error.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_CONTEXT_CHARS = 1500;

export function renderSummary(entries, integrity) {
  if (!entries.length) return null;
  const lines = [`Session ledger: ${integrity} — latest checkpoints:`];
  for (const entry of entries) {
    const goal = entry.goal ? ` — ${entry.goal}` : '';
    const pending = entry.pendingClaims?.length ? ` | pending: ${entry.pendingClaims.join('; ')}` : '';
    lines.push(`#${entry.seq} [${entry.kind}${entry.at ? ` ${entry.at}` : ''}]${goal}${pending} (entry ${entry.hash}, head ${entry.head || 'n/a'})`);
  }
  return lines.join('\n').slice(0, MAX_CONTEXT_CHARS);
}

export function evaluate(payload) {
  // Observing boundary: always allow; the summary is additive context, never a gate.
  return { exitCode: 0, additionalContext: payload || null };
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
  let additionalContext = null;
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
    const ledger = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'session-ledger.mjs');
    const tail = spawnSync(process.execPath, [ledger, 'tail', '--workspace', cwd, '--n', '3'], { encoding: 'utf8', timeout: 10000 });
    const verify = spawnSync(process.execPath, [ledger, 'verify', '--workspace', cwd], { encoding: 'utf8', timeout: 10000 });
    if (tail.status === 0) {
      const entries = JSON.parse(tail.stdout).entries || [];
      const integrity = verify.status === 0 ? 'chain verified' : 'CHAIN INTEGRITY FAILURE — treat claims as unverified';
      additionalContext = renderSummary(entries, integrity)
        || (verify.status === 0 ? null : 'Session ledger: CHAIN INTEGRITY FAILURE — no checkpoint content was loaded; treat all prior claims as unverified.');
    } else {
      additionalContext = 'Session ledger: state was refused as unsafe, malformed, or oversized; no checkpoint content was loaded.';
    }
  } catch {
    additionalContext = 'Session ledger: state could not be inspected safely; no checkpoint content was loaded.';
  }
  if (additionalContext) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`);
  }
  process.exit(0);
}
