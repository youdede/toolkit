#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const MAX_SUMMARY_BYTES = 256 * 1024;
export const MAX_STATE_BYTES = 256 * 1024;
export const MAX_SESSIONS = 64;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function collectContext(input) {
  const transcript = input?.transcript_path;
  if (typeof transcript !== 'string' || !transcript) return { inspectionError: 'transcript-missing' };
  try {
    const metadata = lstatSync(transcript);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_TRANSCRIPT_BYTES) {
      return { inspectionError: 'transcript-unsafe' };
    }
    const raw = readFileSync(transcript);
    return { transcriptBytes: raw.length, transcriptDigest: digest(raw) };
  } catch {
    return { inspectionError: 'transcript-unreadable' };
  }
}

export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { exitCode: 0, ruleId: 'compaction-envelope-invalid', receipt: null };
  }
  if (!['PreCompact', 'PostCompact'].includes(input.hook_event_name)) {
    return { exitCode: 0, ruleId: 'compaction-event-irrelevant', receipt: null };
  }
  if (typeof input.session_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.session_id)) {
    return { exitCode: 0, ruleId: 'compaction-session-invalid', receipt: null };
  }
  if (!['manual', 'auto'].includes(input.trigger) || context.inspectionError) {
    return { exitCode: 0, ruleId: 'compaction-evidence-unavailable', receipt: null };
  }
  const receipt = {
    phase: input.hook_event_name === 'PreCompact' ? 'pre' : 'post',
    trigger: input.trigger,
    transcriptBytes: context.transcriptBytes,
    transcriptDigest: context.transcriptDigest
  };
  if (input.hook_event_name === 'PostCompact') {
    if (typeof input.compact_summary !== 'string' || Buffer.byteLength(input.compact_summary, 'utf8') > MAX_SUMMARY_BYTES) {
      return { exitCode: 0, ruleId: 'compaction-summary-unavailable', receipt: null };
    }
    receipt.summaryBytes = Buffer.byteLength(input.compact_summary, 'utf8');
    receipt.summaryDigest = digest(input.compact_summary);
  } else if (typeof input.custom_instructions === 'string') {
    receipt.instructionBytes = Buffer.byteLength(input.custom_instructions, 'utf8');
    receipt.instructionDigest = digest(input.custom_instructions);
  }
  return { exitCode: 0, ruleId: 'compaction-receipt-ready', sessionKey: digest(input.session_id), receipt };
}

function assertSafeParents(root, target) {
  if (!within(root, target)) throw new Error('state-path-escape');
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('state-path-symlink');
  }
}

function atomicWrite(file, data) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
    writeFileSync(descriptor, data);
    fchmodSync(descriptor, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeReceipt(input, decision, environment = process.env) {
  if (!decision.receipt || !decision.sessionKey) return false;
  if (typeof environment.CLAUDE_PROJECT_DIR !== 'string' || !environment.CLAUDE_PROJECT_DIR) {
    throw new Error('project-root-unavailable');
  }
  const root = realpathSync(environment.CLAUDE_PROJECT_DIR);
  const activeCwd = realpathSync(input.cwd || root);
  if (activeCwd !== root && !within(root, activeCwd)) throw new Error('cwd-outside-project');
  const stateDirectory = path.join(root, '.claude', 'youdede-runtime');
  const stateFile = path.join(stateDirectory, 'compaction-handoff.json');
  assertSafeParents(root, stateDirectory);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  assertSafeParents(root, stateFile);
  let state = { schemaVersion: 1, sessions: {} };
  if (existsSync(stateFile)) {
    const metadata = lstatSync(stateFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STATE_BYTES) throw new Error('state-file-unsafe');
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (state.schemaVersion !== 1 || !state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) {
      throw new Error('state-file-invalid');
    }
  }
  state.sessions[decision.sessionKey] = decision.receipt;
  const keys = Object.keys(state.sessions).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete state.sessions[key];
  const content = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  if (content.length > MAX_STATE_BYTES) throw new Error('state-file-capacity');
  atomicWrite(stateFile, content);
  return true;
}

async function receiveEnvelope() {
  const chunks = [];
  let received = 0;
  for await (const chunk of process.stdin) {
    received += chunk.length;
    if (received > MAX_STDIN_BYTES) throw new Error('compaction input exceeds the bounded size');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

async function runHook() {
  try {
    const input = await receiveEnvelope();
    const decision = evaluate(input, collectContext(input));
    if (decision.receipt && !writeReceipt(input, decision, process.env)) throw new Error('receipt-not-written');
  } catch {
    process.stderr.write('OBSERVED by compaction-handoff-guard [compaction-receipt-unavailable]: a bounded handoff receipt could not be recorded.\n');
  }
  process.exitCode = 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
