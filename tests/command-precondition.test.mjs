import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluatePreconditions } from '../scripts/runtime/command-precondition.mjs';

const BRIDGE = new URL('../scripts/runtime/command-precondition.mjs', import.meta.url).pathname;

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'precondition-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function runBridge(args, cwd) {
  return spawnSync(process.execPath, [BRIDGE, ...args], { encoding: 'utf8', cwd });
}

test('empty check lists pass', () => withTempRoot((root) => {
  assert.deepEqual(evaluatePreconditions({ checks: [] }, root), { ok: true, failures: [] });
}));

test('unknown check types and malformed configs fail closed', () => withTempRoot((root) => {
  assert.ok(!evaluatePreconditions({ checks: [{ type: 'shell-escape' }] }, root).ok);
  assert.ok(!evaluatePreconditions({}, root).ok);
  assert.ok(!evaluatePreconditions({ checks: new Array(33).fill({ type: 'git-clean' }) }, root).ok);
}));

test('git-clean passes on a clean worktree and reports dirty state', () => withTempRoot((root) => {
  git(root, ['init', '-q']);
  writeFileSync(path.join(root, 'tracked.txt'), 'initial\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  assert.ok(evaluatePreconditions({ checks: [{ type: 'git-clean' }] }, root).ok);
  writeFileSync(path.join(root, 'tracked.txt'), 'dirty\n');
  const dirty = evaluatePreconditions({ checks: [{ type: 'git-clean' }] }, root);
  assert.ok(!dirty.ok);
  assert.match(dirty.failures[0], /uncommitted change/);
}));

test('git-clean ignores inherited Git routing variables', () => withTempRoot((root) => {
  git(root, ['init', '-q']);
  writeFileSync(path.join(root, 'tracked.txt'), 'initial\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  const other = mkdtempSync(path.join(os.tmpdir(), 'precondition-other-git-'));
  try {
    git(other, ['init', '-q']);
    writeFileSync(path.join(other, 'dirty.txt'), 'dirty\n');
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other, '.git');
    try {
      assert.equal(evaluatePreconditions({ checks: [{ type: 'git-clean' }] }, root).ok, true);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
}));

test('file-exists rejects traversal, absolute paths, and workspace escapes', () => withTempRoot((root) => {
  writeFileSync(path.join(root, 'present.txt'), 'x\n');
  assert.ok(evaluatePreconditions({ checks: [{ type: 'file-exists', paths: ['present.txt'] }] }, root).ok);
  for (const bad of ['../escape.txt', '..\\escape.txt', '/etc/passwd', 'C:\\Windows\\secret', 'a/../../b']) {
    const result = evaluatePreconditions({ checks: [{ type: 'file-exists', paths: [bad] }] }, root);
    assert.ok(!result.ok, bad);
  }
  const missing = evaluatePreconditions({ checks: [{ type: 'file-exists', paths: ['absent.txt'] }] }, root);
  assert.ok(!missing.ok);
  assert.match(missing.failures[0], /missing: absent\.txt/);
}));

test('file-exists reports a file under missing directories as missing, not as an escape', () => withTempRoot((root) => {
  const result = evaluatePreconditions({ checks: [{ type: 'file-exists', paths: ['.claude/rules/youdede/base.md'] }] }, root);
  assert.deepEqual(result.failures, ['file-exists: missing: .claude/rules/youdede/base.md']);
  if (process.platform === 'win32') return;
  const outside = mkdtempSync(path.join(os.tmpdir(), 'precondition-outside-'));
  try {
    spawnSync('ln', ['-s', outside, path.join(root, 'linked')]);
    const escaped = evaluatePreconditions({ checks: [{ type: 'file-exists', paths: ['linked/absent/file.md'] }] }, root);
    assert.match(escaped.failures[0], /path escapes the workspace/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test('file-exists follows symlinks only inside the workspace', () => withTempRoot((root) => {
  if (process.platform === 'win32') return;
  const outside = mkdtempSync(path.join(os.tmpdir(), 'precondition-outside-'));
  try {
    writeFileSync(path.join(outside, 'secret.txt'), 'x\n');
    spawnSync('ln', ['-s', path.join(outside, 'secret.txt'), path.join(root, 'link.txt')]);
    const result = evaluatePreconditions({ checks: [{ type: 'file-exists', paths: ['link.txt'] }] }, root);
    assert.ok(!result.ok, 'a symlink resolving outside the workspace must be refused');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test('evidence-valid requires parseable JSON objects with declared keys', () => withTempRoot((root) => {
  writeFileSync(path.join(root, 'evidence.json'), '{"phase":"spec","ok":true}\n');
  assert.ok(evaluatePreconditions({ checks: [{ type: 'evidence-valid', path: 'evidence.json', requiredKeys: ['phase'] }] }, root).ok);
  const lacking = evaluatePreconditions({ checks: [{ type: 'evidence-valid', path: 'evidence.json', requiredKeys: ['design'] }] }, root);
  assert.ok(!lacking.ok);
  assert.match(lacking.failures[0], /lacks keys: design/);
  writeFileSync(path.join(root, 'broken.json'), '{nope');
  assert.ok(!evaluatePreconditions({ checks: [{ type: 'evidence-valid', path: 'broken.json' }] }, root).ok);
  writeFileSync(path.join(root, 'list.json'), '[]');
  assert.ok(!evaluatePreconditions({ checks: [{ type: 'evidence-valid', path: 'list.json' }] }, root).ok);
}));

test('the CLI exits 0 on success and 1 with JSON failures on refusal or misuse', () => withTempRoot((root) => {
  writeFileSync(path.join(root, 'config.json'), '{"checks":[{"type":"file-exists","paths":["absent.txt"]}]}');
  const refused = runBridge(['--config', path.join(root, 'config.json'), '--workspace', root], root);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).ok, false);

  writeFileSync(path.join(root, 'ok.json'), '{"checks":[]}');
  const passed = runBridge(['--config', path.join(root, 'ok.json'), '--workspace', root], root);
  assert.equal(passed.status, 0);
  assert.equal(JSON.parse(passed.stdout).ok, true);

  assert.equal(runBridge([], root).status, 1, 'missing --config must fail');
  assert.equal(runBridge(['--config', path.join(root, 'missing.json')], root).status, 1, 'missing config must fail');
}));

test('oversized configs are refused', () => withTempRoot((root) => {
  writeFileSync(path.join(root, 'big.json'), `{"checks":[],"pad":"${'x'.repeat(70 * 1024)}"}`);
  const result = runBridge(['--config', path.join(root, 'big.json'), '--workspace', root], root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /config-limit/);
}));
