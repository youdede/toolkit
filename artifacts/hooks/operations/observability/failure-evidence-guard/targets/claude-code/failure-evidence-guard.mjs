#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_ERROR_BYTES = 64 * 1024;

function cleanToolName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(value) ? value : 'unknown-tool';
}

function classify(error, interrupted) {
  if (interrupted) return 'interrupted';
  const first = String(error || '').slice(0, 4096);
  if (/timed?\s*out|timeout/i.test(first)) return 'timeout';
  if (/permission denied|eacces|eperm|unauthori[sz]ed|forbidden/i.test(first)) return 'authorization';
  if (/cannot find module|module not found|no module named|command not found|enoent/i.test(first)) return 'dependency-or-path';
  if (/connection refused|enotfound|eai_again|network|dns/i.test(first)) return 'network';
  if (/assert|test(?:s| suite)? failed|\bfail(?:ed|ure)?\b/i.test(first)) return 'verification';
  if (/invalid|schema|parse|syntax/i.test(first)) return 'invalid-input-or-syntax';
  return 'unclassified';
}

function exitCodeFrom(error) {
  const match = /^Exit code ([1-9][0-9]{0,2})\b/.exec(String(error || ''));
  return match ? Number(match[1]) : null;
}

function durationBucket(value) {
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  if (value < 1000) return 'under-1s';
  if (value < 10_000) return '1s-10s';
  if (value < 60_000) return '10s-60s';
  return 'over-60s';
}

export function evaluate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { exitCode: 0, ruleId: 'failure-envelope-invalid', output: null };
  }
  if (input.hook_event_name && input.hook_event_name !== 'PostToolUseFailure') {
    return { exitCode: 0, ruleId: 'failure-event-irrelevant', output: null };
  }
  if (typeof input.error !== 'string' || Buffer.byteLength(input.error, 'utf8') > MAX_ERROR_BYTES) {
    return { exitCode: 0, ruleId: 'failure-evidence-unavailable', output: null };
  }
  const category = classify(input.error, input.is_interrupt === true);
  const status = exitCodeFrom(input.error);
  const statusText = status === null ? 'exit=unavailable' : `exit=${status}`;
  const context = [
    'Deterministic failure receipt:',
    `tool=${cleanToolName(input.tool_name)}`,
    `category=${category}`,
    statusText,
    `duration=${durationBucket(input.duration_ms)}`,
    'Treat the original error as evidence; do not report success until a fresh verification passes.'
  ].join(' ');
  return {
    exitCode: 0,
    ruleId: `failure-${category}`,
    output: {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: context
      }
    }
  };
}

async function receiveEnvelope() {
  const chunks = [];
  let received = 0;
  for await (const chunk of process.stdin) {
    received += chunk.length;
    if (received > MAX_STDIN_BYTES) throw new Error('failure input exceeds the bounded size');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

async function runHook() {
  try {
    const decision = evaluate(await receiveEnvelope());
    if (decision.output) process.stdout.write(`${JSON.stringify(decision.output)}\n`);
  } catch {
    process.stderr.write('OBSERVED by failure-evidence-guard [failure-envelope-invalid]: failure evidence could not be normalized.\n');
  }
  process.exitCode = 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
