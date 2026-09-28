#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_PROMPT_BYTES = 256 * 1024;

const RULES = [
  ['prompt-private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['prompt-aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['prompt-github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ['prompt-anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  // A key body is random; lowercase words joined by `-` (sk-dashboard-components-v2-legacy) name something.
  ['prompt-openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, (match) => !/^sk-(?:proj-)?[a-z0-9]+(?:-[a-z0-9]+)+$/.test(match)],
  ['prompt-slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['prompt-stripe-live-key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/]
];

function allow() {
  return { exitCode: 0, ruleId: 'prompt-secret-clear', output: null };
}

const ADVICE = {
  'prompt-analysis-limit': 'Split the prompt into parts smaller than 256 KiB.',
  'prompt-envelope-invalid': 'The hook input could not be read; resubmit the prompt, and check the hook installation if this repeats.'
};

function block(ruleId, reason) {
  return {
    exitCode: 0,
    ruleId,
    output: {
      decision: 'block',
      reason: `Blocked by prompt-secret-guard [${ruleId}]: ${reason}. ${ADVICE[ruleId] ?? 'Remove or redact the credential before resubmitting.'}`,
      suppressOriginalPrompt: true
    }
  };
}

export function evaluate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return block('prompt-envelope-invalid', 'the prompt envelope is not a JSON object');
  }
  if (input.hook_event_name && input.hook_event_name !== 'UserPromptSubmit') return allow();
  if (typeof input.prompt !== 'string') return block('prompt-envelope-invalid', 'the prompt field is missing');
  if (Buffer.byteLength(input.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    return block('prompt-analysis-limit', `the prompt exceeds the ${MAX_PROMPT_BYTES}-byte inspection limit`);
  }
  for (const [ruleId, pattern, accept] of RULES) {
    const found = accept ? [...input.prompt.matchAll(pattern)].some(([match]) => accept(match)) : pattern.test(input.prompt);
    if (found) return block(ruleId, 'a high-confidence credential format was detected');
  }
  return allow();
}

async function receiveEnvelope() {
  const chunks = [];
  let received = 0;
  for await (const chunk of process.stdin) {
    received += chunk.length;
    if (received > MAX_STDIN_BYTES) throw new Error('prompt input exceeds the bounded size');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new Error('prompt input is not valid JSON');
  }
}

async function runHook() {
  let decision;
  try {
    decision = evaluate(await receiveEnvelope());
  } catch (error) {
    decision = block('prompt-envelope-invalid', error.message);
  }
  if (decision.output) process.stdout.write(`${JSON.stringify(decision.output)}\n`);
  process.exitCode = decision.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
