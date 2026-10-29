#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Append-only, hash-chained session ledger. Each entry embeds the previous entry's digest and a
// git anchor (HEAD, branch, dirty-set hash), making retroactive edits detectable. All writes are
// redacted and size-bounded; verification is fully offline. No network, no model judgment.

import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER_RELATIVE = path.join('.youdede', 'session-ledger.jsonl');
const MAX_STDIN_BYTES = 128 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024;
const MAX_LEDGER_BYTES = 1024 * 1024;
const MAX_FIELD_LENGTH = 2000;
const MAX_LIST_ITEMS = 32;
const GIT_TIMEOUT_MS = 5000;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 20;
export const RESTORE_RETENTION_DAYS = 30;
const MAX_SEAL_BYTES = 4096;

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi
];

export function redact(value) {
  if (typeof value !== 'string') return value;
  let out = value.slice(0, MAX_FIELD_LENGTH);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashEntry(entry) {
  return sha256(canonical(entry));
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function gitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
}

function assertSafeFile(file, unsafeCode, aliasCode) {
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(unsafeCode);
  if (realpathSync(file) !== file) throw new Error(aliasCode);
}

function ledgerPaths(workspace, createDirectory = false) {
  const root = realpathSync(workspace);
  if (!lstatSync(root).isDirectory()) throw new Error('workspace-not-directory');
  const directory = path.resolve(root, path.dirname(LEDGER_RELATIVE));
  const file = path.resolve(root, LEDGER_RELATIVE);
  const seal = path.join(directory, 'session-ledger.head.json');
  if (!within(root, directory) || !within(root, file)) throw new Error('ledger-escape');
  if (!existsSync(directory) && createDirectory) {
    try {
      mkdirSync(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  if (existsSync(directory)) {
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('ledger-directory-unsafe');
    if (realpathSync(directory) !== directory) throw new Error('ledger-directory-alias-escape');
  } else if (createDirectory) {
    throw new Error('ledger-directory-missing');
  }
  assertSafeFile(file, 'ledger-unsafe', 'ledger-alias-escape');
  assertSafeFile(seal, 'ledger-seal-unsafe', 'ledger-seal-alias-escape');
  return { root, directory, file, seal, lock: path.join(directory, 'session-ledger.lock') };
}

function sleepBriefly() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
}

function withLedgerLock(workspace, operation) {
  const paths = ledgerPaths(workspace, true);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let descriptor;
  for (;;) {
    try {
      descriptor = openSync(
        paths.lock,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
        0o600
      );
      writeFileSync(descriptor, `${process.pid}\n`);
      closeSync(descriptor);
      descriptor = undefined;
      break;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      descriptor = undefined;
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - statSync(paths.lock).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) {
        try { rmSync(paths.lock, { force: true }); } catch {}
        continue;
      }
      if (Date.now() > deadline) throw new Error('ledger-lock-timeout');
      sleepBriefly();
    }
  }
  try {
    return operation(paths);
  } finally {
    try { rmSync(paths.lock, { force: true }); } catch {}
  }
}

export function gitAnchor(workspace) {
  const base = { head: null, branch: null, dirtyHash: null };
  const probe = (args) => {
    const run = spawnSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: gitEnvironment()
    });
    return run.status === 0 ? run.stdout.trim() : null;
  };
  const head = probe(['rev-parse', 'HEAD']);
  if (!head || !/^[0-9a-f]{40}$/.test(head)) return { ...base, unavailable: true };
  const branch = probe(['branch', '--show-current']) || null;
  const status = probe(['status', '--porcelain']);
  return { head, branch, dirtyHash: status === null ? null : sha256(status) };
}

function cleanString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}-invalid`);
  return redact(value);
}

function cleanStringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw new Error('list-bound');
  return value.map((item) => cleanString(item, label));
}

function safeRelativeFile(value) {
  if (/\0/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const segments = value.split(/[\\/]+/);
  return segments.length > 0 && segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

export function readEntries(workspace) {
  const { file } = ledgerPaths(workspace);
  if (!existsSync(file)) return [];
  if (statSync(file).size > MAX_LEDGER_BYTES) throw new Error('ledger-oversized');
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      return { line: index + 1, entry: parsed };
    } catch {
      return { line: index + 1, entry: null };
    }
  });
}

export function appendEntry(workspace, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('append-input-invalid');
  return withLedgerLock(workspace, ({ file, seal, directory }) => {
    const entries = readEntries(workspace);
    const previous = entries.length > 0 ? entries[entries.length - 1].entry : null;
    if (entries.length > 0 && !previous) throw new Error('ledger-tail-corrupt');
    if (entries.length > 0 && !verifyChain(workspace).ok) throw new Error('ledger-integrity-failed');
    const touchedFiles = cleanStringList(fields.touchedFiles, 'touched-file');
    if (touchedFiles.some((item) => !safeRelativeFile(item))) throw new Error('touched-file-unsafe');
    const entry = {
      seq: entries.length + 1,
      at: new Date().toISOString(),
      kind: fields.kind === undefined ? 'note' : cleanString(fields.kind, 'kind').slice(0, 40),
      reason: fields.reason === undefined ? null : cleanString(fields.reason, 'reason').slice(0, 80),
      goal: fields.goal === undefined || fields.goal === null ? null : cleanString(fields.goal, 'goal'),
      pendingClaims: cleanStringList(fields.pendingClaims, 'pending-claim'),
      decisions: cleanStringList(fields.decisions, 'decision'),
      touchedFiles,
      git: gitAnchor(workspace),
      prevHash: previous ? previous.hash : null
    };
    entry.hash = hashEntry(entry);
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > MAX_ENTRY_BYTES) throw new Error('entry-oversized');
    const existingBytes = existsSync(file) ? statSync(file).size : 0;
    if (existingBytes + lineBytes > MAX_LEDGER_BYTES) throw new Error('ledger-capacity-exceeded');
    const descriptor = openSync(
      file,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
      0o600
    );
    try { writeFileSync(descriptor, line); } finally { closeSync(descriptor); }
    const sealData = `${JSON.stringify({ schemaVersion: 1, entries: entry.seq, lastHash: entry.hash })}\n`;
    const temporarySeal = path.join(directory, `.session-ledger.head.tmp-${process.pid}-${Date.now()}`);
    let sealDescriptor;
    try {
      sealDescriptor = openSync(
        temporarySeal,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
        0o600
      );
      writeFileSync(sealDescriptor, sealData);
      closeSync(sealDescriptor);
      sealDescriptor = undefined;
      renameSync(temporarySeal, seal);
    } finally {
      if (sealDescriptor !== undefined) closeSync(sealDescriptor);
      rmSync(temporarySeal, { force: true });
    }
    return entry;
  });
}

export function verifyChain(workspace) {
  const entries = readEntries(workspace);
  const { seal } = ledgerPaths(workspace);
  const failures = [];
  const anchoredHeads = new Map();
  let previousHash = null;
  for (const [index, { line, entry }] of entries.entries()) {
    if (!entry) {
      failures.push(`line ${line}: entry is not a valid JSON object`);
      previousHash = null;
      continue;
    }
    if (entry.seq !== index + 1) failures.push(`line ${line}: sequence ${entry.seq} expected ${index + 1}`);
    if (entry.prevHash !== previousHash) failures.push(`line ${line}: prevHash does not match the previous entry`);
    const { hash, ...body } = entry;
    if (!/^[0-9a-f]{64}$/.test(hash || '') || hashEntry(body) !== hash) failures.push(`line ${line}: digest mismatch; entry was modified after append`);
    if (entry.git?.head !== null && entry.git?.head !== undefined && !/^[0-9a-f]{40}$/.test(entry.git.head)) failures.push(`line ${line}: git anchor head is malformed`);
    if (/^[0-9a-f]{40}$/.test(entry.git?.head || '') && !anchoredHeads.has(entry.git.head)) anchoredHeads.set(entry.git.head, line);
    if (entry.git?.dirtyHash !== null && entry.git?.dirtyHash !== undefined && !/^[0-9a-f]{64}$/.test(entry.git.dirtyHash)) failures.push(`line ${line}: git dirty-set hash is malformed`);
    previousHash = entry.hash ?? null;
  }
  for (const [head, line] of anchoredHeads) {
    const probe = spawnSync('git', ['-C', workspace, 'cat-file', '-e', `${head}^{commit}`], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      env: gitEnvironment()
    });
    if (probe.status !== 0) failures.push(`line ${line}: git anchor commit is not available in this repository`);
  }
  let sealedHead = null;
  if (entries.length === 0) {
    if (existsSync(seal)) failures.push('head seal exists for an empty ledger');
  } else if (!existsSync(seal)) {
    failures.push('head seal is missing; tail deletion cannot be excluded');
  } else if (statSync(seal).size > MAX_SEAL_BYTES) {
    failures.push('head seal exceeds its size bound');
  } else {
    try {
      const parsed = JSON.parse(readFileSync(seal, 'utf8'));
      if (parsed?.schemaVersion !== 1 || parsed.entries !== entries.length || parsed.lastHash !== previousHash) {
        failures.push('head seal does not match the ledger tail; truncation or an incomplete write was detected');
      } else {
        sealedHead = parsed.lastHash;
      }
    } catch {
      failures.push('head seal is malformed');
    }
  }
  return { ok: failures.length === 0, entries: entries.length, lastHash: sealedHead, failures };
}

export function tailSummary(workspace, count = 3, now = Date.now()) {
  const cutoff = now - RESTORE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = readEntries(workspace)
    .filter(({ entry }) => entry && Number.isFinite(Date.parse(entry.at)) && Date.parse(entry.at) >= cutoff)
    .slice(-Math.max(1, Math.min(count, 10)));
  return entries.filter(({ entry }) => entry).map(({ entry }) => ({
    seq: entry.seq,
    at: entry.at,
    kind: entry.kind,
    goal: entry.goal,
    pendingClaims: entry.pendingClaims,
    head: entry.git?.head ? entry.git.head.slice(0, 12) : null,
    hash: entry.hash.slice(0, 12)
  }));
}

async function readStdin(limit = MAX_STDIN_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('stdin-limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const workspaceFlag = argv.indexOf('--workspace');
  const workspace = path.resolve(workspaceFlag >= 0 ? argv[workspaceFlag + 1] : process.cwd());
  const out = (value, code = 0) => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    process.exit(code);
  };
  try {
    if (command === 'append') {
      const raw = await readStdin();
      const fields = raw.trim() ? JSON.parse(raw) : {};
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('append-input-invalid');
      out({ ok: true, entry: appendEntry(workspace, fields) });
    } else if (command === 'verify') {
      const result = verifyChain(workspace);
      out(result, result.ok ? 0 : 1);
    } else if (command === 'tail') {
      const nFlag = argv.indexOf('--n');
      out({ ok: true, entries: tailSummary(workspace, nFlag >= 0 ? Number(argv[nFlag + 1]) : 3) });
    } else {
      out({ ok: false, failures: ['usage: session-ledger <append|verify|tail> [--workspace <dir>] [--n <count>]'] }, 1);
    }
  } catch (error) {
    out({ ok: false, failures: [error.message] }, 1);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
