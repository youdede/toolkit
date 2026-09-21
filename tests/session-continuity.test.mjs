import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../scripts/lib/catalog.mjs';
import { installArtifact, removeArtifact } from '../scripts/lib/install.mjs';
import { evaluate as evaluateBudget } from '../artifacts/hooks/development/resource-management/tool-output-budget-guard/targets/claude-code/tool-output-budget-guard.mjs';

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'session-continuity-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function initRepo(root) {
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty'], { cwd: root });
}

function runHook(project, slug, input) {
  const script = path.join(project, '.claude', 'hooks', 'youdede', `${slug}.mjs`);
  return spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', cwd: project });
}

function installSessionHooks(project) {
  for (const slug of ['session-checkpoint-guard', 'session-restore-guard', 'compact-readiness-guard']) {
    installArtifact(slug, { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
  }
}

test('allow: session lifecycle writes receipts, restores summaries, and removes cleanly', () => withTempRoot((root) => {
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  initRepo(project);
  installSessionHooks(project);
  assert.ok(existsSync(path.join(project, '.claude', 'hooks', 'youdede', 'compact-readiness-guard.mjs')));

  const end = runHook(project, 'session-checkpoint-guard', { cwd: project, reason: 'test-exit' });
  assert.equal(end.status, 0);
  const ledger = path.join(project, '.youdede', 'session-ledger.jsonl');
  assert.ok(existsSync(ledger), 'a receipt was appended');
  const entry = JSON.parse(readFileSync(ledger, 'utf8').trim().split('\n').pop());
  assert.equal(entry.kind, 'session-end');
  assert.match(entry.hash, /^[0-9a-f]{64}$/);

  const start = runHook(project, 'session-restore-guard', { cwd: project });
  assert.equal(start.status, 0);
  const context = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /chain verified/);
  assert.match(context, /#1 \[session-end/);

  const sharedRuntime = path.join(project, '.claude', 'hooks', 'youdede', 'lib', 'session-ledger.mjs');
  const installedSlugs = ['session-checkpoint-guard', 'session-restore-guard', 'compact-readiness-guard'];
  for (const [index, slug] of installedSlugs.entries()) {
    removeArtifact(slug, { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
    assert.equal(existsSync(sharedRuntime), index < installedSlugs.length - 1, 'shared runtime survives until its final owner leaves');
  }
  assert.ok(!existsSync(path.join(project, '.claude', 'hooks', 'youdede', 'session-checkpoint-guard.mjs')));
}));

test('deny-or-observe: a tampered ledger is surfaced as an integrity failure, never trusted silently', () => withTempRoot((root) => {
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  initRepo(project);
  installArtifact('session-checkpoint-guard', { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
  installArtifact('session-restore-guard', { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
  runHook(project, 'session-checkpoint-guard', { cwd: project, reason: 'x' });
  const ledger = path.join(project, '.youdede', 'session-ledger.jsonl');
  writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('session-end', 'session-END'));
  const start = runHook(project, 'session-restore-guard', { cwd: project });
  assert.equal(start.status, 0, 'restore never blocks');
  assert.match(start.stdout, /CHAIN INTEGRITY FAILURE/);
}));

test('deny-or-observe: malformed ledger state produces bounded unverified context instead of disappearing', () => withTempRoot((root) => {
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  initRepo(project);
  installArtifact('session-restore-guard', { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
  mkdirSync(path.join(project, '.youdede'), { recursive: true });
  writeFileSync(path.join(project, '.youdede', 'session-ledger.jsonl'), 'not-json\n');
  const start = runHook(project, 'session-restore-guard', { cwd: project });
  assert.equal(start.status, 0);
  assert.match(start.stdout, /CHAIN INTEGRITY FAILURE|refused as unsafe, malformed, or oversized/);
}));

test('malformed: hooks fail open on garbage input and still exit 0', () => withTempRoot((root) => {
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  initRepo(project);
  installSessionHooks(project);
  for (const slug of ['session-checkpoint-guard', 'session-restore-guard', 'compact-readiness-guard']) {
    const run = spawnSync(process.execPath, [path.join(project, '.claude', 'hooks', 'youdede', `${slug}.mjs`)], { input: '{nope', encoding: 'utf8', cwd: project });
    assert.equal(run.status, 0, slug);
  }
}));

test('boundary: compact-readiness warns only about real dirty state and pending claims', () => withTempRoot((root) => {
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  initRepo(project);
  installSessionHooks(project);
  spawnSync('git', ['add', '.'], { cwd: project });
  spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'install session hooks'], { cwd: project });
  const clean = runHook(project, 'compact-readiness-guard', { cwd: project });
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout.trim(), '', 'clean tree and empty ledger produce no warning');
  writeFileSync(path.join(project, 'dirty.txt'), 'x\n');
  const dirty = runHook(project, 'compact-readiness-guard', { cwd: project });
  assert.match(dirty.stdout, /uncommitted change/);
}));

test('false-positive: the output budget guard ignores output within budget', () => {
  assert.equal(evaluateBudget({ outputBytes: 1024, budget: 65536 }).guidance, null);
  assert.equal(evaluateBudget(null).guidance, null);
  assert.equal(evaluateBudget({ outputBytes: -5, budget: 65536 }).guidance, null);
});

test('process-exit: the budget guard exits 0 while flagging oversized output without echoing it', () => {
  const script = path.resolve('artifacts/hooks/development/resource-management/tool-output-budget-guard/targets/claude-code/tool-output-budget-guard.mjs');
  const big = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: 'Bash', tool_response: 'y'.repeat(70 * 1024) }), encoding: 'utf8' });
  assert.equal(big.status, 0);
  assert.match(big.stdout, /budget/);
  assert.ok(!big.stdout.includes('yyyy'), 'guidance never echoes observed content');
  const small = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: 'Bash', tool_response: 'ok' }), encoding: 'utf8' });
  assert.equal(small.status, 0);
  assert.equal(small.stdout.trim(), '');
});

test('oversized: observing hook wrappers remain fail-open without reflecting oversized input', () => withTempRoot((root) => {
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  initRepo(project);
  installSessionHooks(project);
  const script = path.join(project, '.claude', 'hooks', 'youdede', 'session-restore-guard.mjs');
  const run = spawnSync(process.execPath, [script], { input: 'x'.repeat(1024 * 1024 + 1), encoding: 'utf8', cwd: project });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /state could not be inspected safely/);
  assert.ok(run.stdout.length < 500, 'oversized input is never reflected into context');
}));

test('positive: installed session commands execute their shared deterministic precondition bridge', () => withTempRoot((root) => {
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  initRepo(project);
  for (const slug of ['record-work-checkpoint', 'verify-session-ledger']) {
    installArtifact(slug, { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
    const preconditions = path.join(project, '.claude', 'commands', 'youdede', slug, 'check-preconditions.mjs');
    const run = spawnSync(process.execPath, [preconditions, '--workspace', project], { encoding: 'utf8', cwd: project });
    assert.equal(run.status, 0, `${slug}: ${run.stderr}`);
    assert.equal(JSON.parse(run.stdout).ok, true);
  }
  for (const slug of ['record-work-checkpoint', 'verify-session-ledger']) {
    removeArtifact(slug, { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
  }
}));
