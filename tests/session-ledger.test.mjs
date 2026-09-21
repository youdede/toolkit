import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appendEntry, verifyChain, tailSummary, redact, RESTORE_RETENTION_DAYS } from '../scripts/runtime/session-ledger.mjs';

const CORE = new URL('../scripts/runtime/session-ledger.mjs', import.meta.url).pathname;

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'session-ledger-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function initRepo(root) {
  git(root, ['init', '-q']);
  git(root, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty']);
}

test('positive: entries append with sequence, chain links, redaction, and git anchors', () => withTempRoot((root) => {
  initRepo(root);
  const first = appendEntry(root, { kind: 'checkpoint', goal: 'ship the thing', touchedFiles: ['src/a.js'] });
  assert.equal(first.seq, 1);
  assert.equal(first.prevHash, null);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.touchedFiles, ['src/a.js']);
  assert.match(first.git.head, /^[0-9a-f]{40}$/);
  const second = appendEntry(root, { kind: 'checkpoint', goal: 'next' });
  assert.equal(second.seq, 2);
  assert.equal(second.prevHash, first.hash);
  assert.ok(verifyChain(root).ok);
}));

test('negative: git anchor fields are covered by the entry digest', () => withTempRoot((root) => {
  initRepo(root);
  appendEntry(root, { kind: 'checkpoint', goal: 'anchor integrity' });
  const file = path.join(root, '.youdede', 'session-ledger.jsonl');
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  entry.git.branch = 'tampered-branch';
  writeFileSync(file, `${JSON.stringify(entry)}\n`);
  assert.match(verifyChain(root).failures.join('\n'), /digest mismatch/);
}));

test('negative: tampering with any entry breaks verification at that line', () => withTempRoot((root) => {
  initRepo(root);
  appendEntry(root, { kind: 'a', goal: 'one' });
  appendEntry(root, { kind: 'b', goal: 'two' });
  const file = path.join(root, '.youdede', 'session-ledger.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"one"', '"ONE"'));
  const result = verifyChain(root);
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /line 1: digest mismatch/);
}));

test('negative: deleting the ledger tail is detected by the independently stored head seal', () => withTempRoot((root) => {
  initRepo(root);
  appendEntry(root, { kind: 'a', goal: 'one' });
  appendEntry(root, { kind: 'b', goal: 'two' });
  const file = path.join(root, '.youdede', 'session-ledger.jsonl');
  const [first] = readFileSync(file, 'utf8').trim().split('\n');
  writeFileSync(file, `${first}\n`);
  const result = verifyChain(root);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /head seal does not match/);
}));

test('malformed: invalid fields, oversized input, and corrupt tails are refused', () => withTempRoot((root) => {
  initRepo(root);
  assert.throws(() => appendEntry(root, { pendingClaims: ['ok', 42] }), /pending-claim-invalid/);
  mkdirSync(path.join(root, '.youdede'), { recursive: true });
  writeFileSync(path.join(root, '.youdede', 'session-ledger.jsonl'), 'not json\n');
  const result = verifyChain(root);
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /not a valid JSON object/);
  assert.throws(() => appendEntry(root, { kind: 'after-corruption' }), /ledger-tail-corrupt/);
}));

test('boundary: symlinked ledgers are never written through or read', () => withTempRoot((root) => {
  if (process.platform === 'win32') return;
  initRepo(root);
  const outside = mkdtempSync(path.join(tmpdir(), 'ledger-outside-'));
  try {
    const target = path.join(outside, 'real.jsonl');
    writeFileSync(target, '');
    mkdirSync(path.join(root, '.youdede'), { recursive: true });
    symlinkSync(target, path.join(root, '.youdede', 'session-ledger.jsonl'));
    assert.throws(() => appendEntry(root, { kind: 'x' }), /ledger-(unsafe|alias-escape)/);
    assert.equal(readFileSync(target, 'utf8'), '', 'nothing was written through the symlink');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test('boundary: a symlinked state directory is never traversed', () => withTempRoot((root) => {
  if (process.platform === 'win32') return;
  initRepo(root);
  const outside = mkdtempSync(path.join(tmpdir(), 'ledger-dir-outside-'));
  try {
    symlinkSync(outside, path.join(root, '.youdede'));
    assert.throws(() => appendEntry(root, { kind: 'x' }), /ledger-directory-unsafe/);
    assert.throws(() => readFileSync(path.join(outside, 'session-ledger.jsonl'), 'utf8'), /ENOENT/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test('boundary: portable absolute and traversal paths are refused', () => withTempRoot((root) => {
  initRepo(root);
  for (const touchedFile of ['/etc/passwd', '../escape', '..\\escape', 'C:\\Windows\\secret']) {
    assert.throws(() => appendEntry(root, { kind: 'x', touchedFiles: [touchedFile] }), /touched-file-unsafe/);
  }
}));

test('boundary: inherited Git routing variables cannot redirect an entry anchor', () => withTempRoot((root) => {
  initRepo(root);
  const other = mkdtempSync(path.join(tmpdir(), 'ledger-other-git-'));
  try {
    initRepo(other);
    const expected = git(root, ['rev-parse', 'HEAD']).stdout.trim();
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other, '.git');
    try {
      assert.equal(appendEntry(root, { kind: 'checkpoint' }).git.head, expected);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
}));

test('redaction strips secret shapes before any write', () => withTempRoot((root) => {
  initRepo(root);
  const awsKeyShape = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  const privateKeyShape = ['-----BEGIN PRIVATE', ' KEY-----\nabc\n-----END PRIVATE', ' KEY-----'].join('');
  const entry = appendEntry(root, { kind: 'checkpoint', goal: `rotate ${awsKeyShape} and token=supersecretvalue123` });
  assert.ok(!entry.goal.includes(awsKeyShape));
  assert.ok(entry.goal.includes('[redacted]'));
  const raw = readFileSync(path.join(root, '.youdede', 'session-ledger.jsonl'), 'utf8');
  assert.ok(!raw.includes(awsKeyShape), 'the stored line carries no secret');
  assert.equal(redact(privateKeyShape), '[redacted]');
}));

test('tailSummary is bounded and carries citation handles', () => withTempRoot((root) => {
  initRepo(root);
  for (let index = 0; index < 5; index += 1) appendEntry(root, { kind: 'n', goal: `entry ${index}` });
  const tail = tailSummary(root, 3);
  assert.equal(tail.length, 3);
  assert.equal(tail[2].seq, 5);
  assert.match(tail[2].hash, /^[0-9a-f]{12}$/);
}));

test('retention: restore summaries omit entries beyond the declared horizon without rewriting the ledger', () => withTempRoot((root) => {
  initRepo(root);
  const entry = appendEntry(root, { kind: 'checkpoint', goal: 'old context' });
  const future = Date.parse(entry.at) + (RESTORE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
  assert.deepEqual(tailSummary(root, 3, future), []);
  assert.equal(readFileSync(path.join(root, '.youdede', 'session-ledger.jsonl'), 'utf8').trim().length > 0, true);
}));

test('concurrency: simultaneous appenders receive unique monotonic sequence numbers', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'session-ledger-concurrent-'));
  try {
    initRepo(root);
    const runs = Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CORE, 'append', '--workspace', root], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout).entry) : reject(new Error(stderr || stdout)));
      child.stdin.end(JSON.stringify({ kind: 'concurrent', goal: `writer ${index}` }));
    }));
    const entries = await Promise.all(runs);
    assert.deepEqual(entries.map(({ seq }) => seq).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(verifyChain(root).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('process-exit: the CLI exits 0 on verify success and 1 with failures on tamper', () => withTempRoot((root) => {
  initRepo(root);
  const append = spawnSync(process.execPath, [CORE, 'append', '--workspace', root], { input: '{"kind":"cli"}', encoding: 'utf8' });
  assert.equal(append.status, 0, append.stderr);
  const ok = spawnSync(process.execPath, [CORE, 'verify', '--workspace', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  const file = path.join(root, '.youdede', 'session-ledger.jsonl');
  writeFileSync(file, `${readFileSync(file, 'utf8')}garbage\n`);
  const bad = spawnSync(process.execPath, [CORE, 'verify', '--workspace', root], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const usage = spawnSync(process.execPath, [CORE], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
}));
