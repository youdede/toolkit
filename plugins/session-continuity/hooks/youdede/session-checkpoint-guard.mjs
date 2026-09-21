#!/usr/bin/env node

// Appends a deterministic session-end receipt to the hash-chained session ledger. Records only
// what the event itself proves: timestamp, reason, sequence, chain link, and git anchor. Content
// rich checkpoints belong to the record-work-checkpoint command, never to an automatic hook.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;

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

export function receiptFields(input) {
  const reason = typeof input?.reason === 'string' ? input.reason.slice(0, 80) : 'unknown';
  return { kind: 'session-end', goal: null, pendingClaims: [], decisions: [], touchedFiles: [], reason };
}

export function evaluate() {
  // Observing boundary: a receipt write must never block a session from ending.
  return { exitCode: 0 };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
    const ledger = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'session-ledger.mjs');
    const fields = receiptFields(input);
    await new Promise((resolve) => {
      const child = spawnSync(process.execPath, [ledger, 'append', '--workspace', cwd], {
        input: JSON.stringify(fields),
        encoding: 'utf8',
        timeout: 10000
      });
      resolve(child);
    });
  } catch {
    // fail open: observation gaps are reported by the next verify-session-ledger run
  }
  process.exit(0);
}
