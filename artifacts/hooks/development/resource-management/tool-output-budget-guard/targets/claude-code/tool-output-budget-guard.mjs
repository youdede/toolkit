#!/usr/bin/env node

// Observes shell tool output size against a declared per-call byte budget and emits bounded
// guidance when output exceeds it, so context pressure becomes visible instead of silent.
// Never blocks, never rewrites output, never echoes observed content.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 8 * 1024 * 1024;
export const OUTPUT_BUDGET_BYTES = 64 * 1024;

export function evaluate(context) {
  if (!context || typeof context.outputBytes !== 'number' || context.outputBytes < 0) return { exitCode: 0, guidance: null };
  if (context.outputBytes <= context.budget) return { exitCode: 0, guidance: null };
  const ratio = (context.outputBytes / context.budget).toFixed(1);
  return {
    exitCode: 0,
    guidance: `Tool output used ~${Math.round(context.outputBytes / 1024)} KiB (${ratio}x the ${Math.round(context.budget / 1024)} KiB budget). Re-run with pagination, filtering, or output redirected to a file you then read in slices.`
  };
}

export function collectContext(input) {
  const response = input?.tool_response;
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return { outputBytes: Buffer.byteLength(text, 'utf8'), budget: OUTPUT_BUDGET_BYTES };
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let guidance = null;
  try {
    const raw = await readStdin();
    // Input above the read limit is the largest output of all: it is reported without parsing.
    guidance = raw === null
      ? `Tool output exceeded the ${MAX_STDIN_BYTES / 1024 / 1024} MiB inspection limit (more than ${Math.round(MAX_STDIN_BYTES / OUTPUT_BUDGET_BYTES)}x the ${OUTPUT_BUDGET_BYTES / 1024} KiB budget). Re-run with pagination, filtering, or output redirected to a file you then read in slices.`
      : evaluate(collectContext(raw.trim() ? JSON.parse(raw) : {})).guidance;
  } catch {
    guidance = null;
  }
  if (guidance) process.stdout.write(`${JSON.stringify({ systemMessage: guidance })}\n`);
  process.exit(0);
}
