#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
export const MAX_SUBAGENT_CALLS = 8;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by subagent-fanout-guard [' + ruleId + ']: ' + detail + '.' }; }

function transcriptEvents(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try { const value = JSON.parse(trimmed); return Array.isArray(value) ? value : [value]; }
  catch {
    const events = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); }
      catch { throw new Error('transcript-invalid'); }
    }
    return events;
  }
}
function delegationCount(events) {
  const identities = new Set(); let anonymous = 0;
  function visit(value) {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== 'object') return;
    const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
    const name = value.name ?? value.tool_name;
    if (/^(?:Task|Agent)$/.test(name || '') && /^(?:tool_use|tool_call|pre_tool_use|tooluse)$/.test(type)) {
      const id = value.id ?? value.tool_use_id ?? value.call_id;
      if (typeof id === 'string' && id) identities.add(id); else anonymous += 1;
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  }
  for (const event of events) visit(event);
  return identities.size + anonymous;
}
export function collectContext(input) {
  if (!/^(?:Task|Agent)$/.test(input?.tool_name || '')) return {};
  const transcript = input?.transcript_path;
  if (typeof transcript !== 'string' || !transcript) return { inspectionError: 'transcript-missing' };
  try {
    const stat = lstatSync(transcript);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_BYTES) return { inspectionError: 'transcript-unsafe' };
    return { priorDelegations: delegationCount(transcriptEvents(readFileSync(transcript, 'utf8'))) };
  } catch (error) { return { inspectionError: error.message === 'transcript-invalid' ? 'transcript-invalid' : 'transcript-unreadable' }; }
}

export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_name) return block('subagent-fanout-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Task|Agent)$/.test(input.tool_name)) return allow();
  if (context.inspectionError || !Number.isInteger(context.priorDelegations) || context.priorDelegations < 0) return block('subagent-budget-unverified', 'the session transcript cannot establish the delegation budget');
  if (context.priorDelegations >= MAX_SUBAGENT_CALLS) return block('subagent-budget-exhausted', 'the session has reached its bounded delegation budget');
  return allow();
}

async function receiveEnvelope() {
  const chunks = []; let received = 0;
  for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); }
  try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; }
  catch { throw new Error('hook input is not valid JSON'); }
}
async function runHook() {
  let result;
  try { const input = await receiveEnvelope(); result = evaluate(input, collectContext(input)); }
  catch (error) { result = block('subagent-fanout-input-invalid', error.message); }
  if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
