#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 64 * 1024;
const REQUIRED_MARKER = /\[youdede:evidence-required(?:\s+id=[A-Za-z0-9._:-]{1,64})?\]/i;

function allow(ruleId = 'completion-evidence-not-required') {
  return { exitCode: 0, ruleId, message: '' };
}

function block(ruleId, detail) {
  return { exitCode: 2, ruleId, message: `BLOCKED by completion-evidence-guard [${ruleId}]: ${detail}.` };
}

function strings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, output);
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) strings(entry, output);
  return output;
}

// The prompts of the subagents an assistant message starts (`Agent`, or `Task` in older transcripts).
function agentPrompts(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter((part) => part?.type === 'tool_use' && ['Agent', 'Task'].includes(part.name) && typeof part.input?.prompt === 'string')
    .map((part) => part.input.prompt);
}

function transcriptContext(raw) {
  const assistantValues = [];
  const userValues = [];
  const prompts = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const assistant = event?.type === 'assistant'
        || event?.role === 'assistant'
        || event?.message?.role === 'assistant';
      if (assistant) {
        strings(event?.message ?? event?.content ?? event, assistantValues);
        prompts.push(...agentPrompts(event?.message ?? event));
      }
      const user = event?.type === 'user'
        || event?.role === 'user'
        || event?.message?.role === 'user';
      if (user) strings(event?.message ?? event?.content ?? event, userValues);
    }
    catch { throw new Error('transcript-invalid'); }
  }
  return {
    // A subagent is opted in by the latest user message or by the prompt it was started with.
    latestUserMarker: REQUIRED_MARKER.test(userValues.at(-1) || '') || REQUIRED_MARKER.test(prompts.at(-1) || ''),
    lastAssistant: [...assistantValues].reverse().find((value) => /\[youdede:evidence\b/i.test(value)) || ''
  };
}

export function collectContext(input) {
  const transcript = input?.transcript_path;
  if (typeof transcript !== 'string' || !transcript) return { inspectionError: 'transcript-missing' };
  try {
    const stat = lstatSync(transcript);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_BYTES) {
      return { inspectionError: 'transcript-unsafe' };
    }
    return transcriptContext(readFileSync(transcript, 'utf8'));
  } catch (error) {
    return { inspectionError: error.message === 'transcript-invalid' ? error.message : 'transcript-unreadable' };
  }
}

function hasReceipt(message, taskId) {
  if (typeof message !== 'string' || Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) return false;
  const receipt = /\[youdede:evidence\s+status=pass(?:\s+task=([A-Za-z0-9._:-]{1,64}))?\]/i.exec(message);
  if (!receipt) return false;
  if (taskId && receipt[1] !== taskId) return false;
  const source = /^\s*(?:source|command|check)\s*:\s*\S.{0,300}$/im.test(message);
  const result = /^\s*result\s*:\s*(?:pass|passed|success|exit\s+0)\s*$/im.test(message);
  return source && result;
}

export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return block('completion-envelope-invalid', 'the hook envelope is invalid');
  }
  const event = input.hook_event_name;
  if (!['TaskCompleted', 'SubagentStop'].includes(event)) return allow('completion-event-irrelevant');

  // A TaskCompleted event opts in through its task description alone, so an ordinary task needs no
  // transcript. A SubagentStop event may opt in through the transcript, which must then be readable.
  const descriptionRequires = typeof input.task_description === 'string' && REQUIRED_MARKER.test(input.task_description);
  if (event === 'TaskCompleted' && !descriptionRequires) return allow();
  if (context.inspectionError) return block('completion-evidence-unverified', 'the bounded transcript could not be inspected');
  const required = descriptionRequires || context.latestUserMarker === true;
  if (!required) return allow();

  const message = event === 'SubagentStop' && typeof input.last_assistant_message === 'string'
    ? input.last_assistant_message
    : context.lastAssistant;
  if (!hasReceipt(message, event === 'TaskCompleted' ? input.task_id : null)) {
    return block('completion-evidence-missing', 'the evidence-required task has no matching pass receipt with a source and result');
  }
  return allow('completion-evidence-present');
}

async function receiveEnvelope() {
  const chunks = [];
  let received = 0;
  for await (const chunk of process.stdin) {
    received += chunk.length;
    if (received > MAX_STDIN_BYTES) throw new Error('completion input exceeds the bounded size');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw.trim() ? JSON.parse(raw) : {}; }
  catch { throw new Error('completion input is not valid JSON'); }
}

async function runHook() {
  let decision;
  try {
    const input = await receiveEnvelope();
    decision = evaluate(input, collectContext(input));
  } catch (error) {
    decision = block('completion-envelope-invalid', error.message);
  }
  if (decision.message) process.stderr.write(`${decision.message}\n`);
  process.exitCode = decision.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
