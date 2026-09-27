import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_COMMIT_HEADER_CHARACTERS,
  evaluateBranchName,
  evaluateCommitMessage
} from '../scripts/validate-change-policy.mjs';
import { resolveNpmPackInvocation, spawnFailureDetail } from '../scripts/verify-package-command.mjs';
import { discoverTestFiles } from '../scripts/run-tests.mjs';
import { cleanGitEnvironment } from './git-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_CLI = path.join(ROOT, 'scripts', 'validate-change-policy.mjs');

test('commit policy accepts conventional headers and explicit breaking changes', () => {
  assert.deepEqual(evaluateCommitMessage('feat(cli): verify artifact integrity'), { valid: true, violations: [] });
  assert.deepEqual(evaluateCommitMessage([
    'feat(installer)!: remove legacy target alias',
    '',
    'The legacy alias cannot preserve the documented authority boundary.',
    '',
    'BREAKING CHANGE: callers must use the canonical target id'
  ].join('\n')), { valid: true, violations: [] });
});

test('commit policy rejects temporary, malformed, oversized, and ambiguous headers', () => {
  const temporary = evaluateCommitMessage('WIP: almost done');
  assert.equal(temporary.valid, false);
  assert.ok(temporary.violations.some(({ rule }) => rule === 'COMMIT_TEMPORARY_PREFIX'));

  const malformed = evaluateCommitMessage('Fix parser.');
  assert.equal(malformed.valid, false);
  assert.ok(malformed.violations.some(({ rule }) => rule === 'COMMIT_HEADER_FORMAT'));

  const oversized = evaluateCommitMessage(`fix(cli): ${'a'.repeat(MAX_COMMIT_HEADER_CHARACTERS)}`);
  assert.equal(oversized.valid, false);
  assert.ok(oversized.violations.some(({ rule }) => rule === 'COMMIT_HEADER_LENGTH'));

  // The squash-merge suffix is ignored only for history already on main; elsewhere it counts.
  const squashHeader = `fix(cli): ${'a'.repeat(MAX_COMMIT_HEADER_CHARACTERS - 10)} (#1234)`;
  const squashed = evaluateCommitMessage(squashHeader, { squashSuffix: true });
  assert.equal(squashed.violations.some(({ rule }) => rule === 'COMMIT_HEADER_LENGTH'), false);
  assert.ok(evaluateCommitMessage(squashHeader).violations.some(({ rule }) => rule === 'COMMIT_HEADER_LENGTH'));
  assert.ok(evaluateCommitMessage(`fix: ${'a'.repeat(66)} (#1)`).violations.some(({ rule }) => rule === 'COMMIT_HEADER_LENGTH'));
  const oversizedSquash = evaluateCommitMessage(`fix(cli): ${'a'.repeat(MAX_COMMIT_HEADER_CHARACTERS)} (#1234)`, { squashSuffix: true });
  assert.ok(oversizedSquash.violations.some(({ rule }) => rule === 'COMMIT_HEADER_LENGTH'));

  const breaking = evaluateCommitMessage('feat!: remove compatibility alias');
  assert.equal(breaking.valid, false);
  assert.ok(breaking.violations.some(({ rule }) => rule === 'COMMIT_BREAKING_FOOTER'));
});

test('the squash-merge suffix exception needs a commit reachable from origin/main, not only a label (PR38-CODEX8-4)', (context) => {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'youdede-policy-main-'));
  context.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repository, env: cleanGitEnvironment(), encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  };
  const policy = (label) => spawnSync(process.execPath, [POLICY_CLI, '--range', 'HEAD^..HEAD', '--label', label], { cwd: repository, env: cleanGitEnvironment(), encoding: 'utf8' }).status;
  const suffixed = `fix: ${'a'.repeat(66)} (#1)`;
  git('init', '-q');
  git('config', 'user.email', 'tests@youdede.invalid');
  git('config', 'user.name', 'youdede tests');
  git('commit', '-q', '--allow-empty', '-m', 'chore: start');
  git('commit', '-q', '--allow-empty', '-m', suffixed);
  // Without origin/main no commit gets the exception, whatever the label.
  assert.equal(policy('pull-request-commit'), 1);
  assert.equal(policy('repository-commit'), 1);
  // A commit reachable from origin/main gets it, but only under the repository-commit label.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(policy('repository-commit'), 0);
  assert.equal(policy('pushed-commit'), 1);
  // A later commit that is not on origin/main is measured whole.
  git('commit', '-q', '--allow-empty', '-m', suffixed);
  assert.equal(policy('repository-commit'), 1);
});

test('branch policy accepts controlled automation and contributor prefixes', () => {
  for (const branch of [
    'feat/catalog-search',
    'security/release-boundary',
    'codex/repository-governance',
    'agent/review-release-evidence',
    'dependabot/npm_and_yarn/actions/checkout-6'
  ]) {
    assert.deepEqual(evaluateBranchName(branch), { valid: true, violations: [] }, branch);
  }
  assert.equal(evaluateBranchName('my cool branch').valid, false);
  assert.equal(evaluateBranchName('feature/MixedCase').valid, false);
});

test('policy CLI fails closed without echoing rejected commit content', () => {
  const sensitiveMarker = 'WIP: internal-customer-name';
  const result = spawnSync(process.execPath, [POLICY_CLI, '--message', sensitiveMarker, '--label', 'test'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CHANGE_POLICY_FAIL test COMMIT_TEMPORARY_PREFIX/u);
  assert.doesNotMatch(result.stderr, /internal-customer-name/u);
});

test('policy CLI rejects symbolic-link commit message input', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'toolkit-governance-'));
  try {
    const target = path.join(directory, 'message.txt');
    const link = path.join(directory, 'message-link.txt');
    writeFileSync(target, 'fix(cli): reject unsafe input\n');
    symlinkSync(target, link);
    const result = spawnSync(process.execPath, [POLICY_CLI, '--file', link], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /CHANGE_POLICY_ERROR/u);
    assert.doesNotMatch(result.stderr, /fix\(cli\)/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repository workflows pin every third-party action to a commit', () => {
  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
  const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/gu)].map((match) => match[1]);
  assert.ok(actionReferences.length > 0);
  for (const reference of actionReferences) {
    assert.match(reference, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u, reference);
  }
  assert.match(workflow, /name:\s+quality-gate/u);
});

test('package verification invokes npm portably and reports spawn failures safely', () => {
  assert.deepEqual(resolveNpmPackInvocation({
    platform: 'win32',
    nodeExecutable: 'C:\\node.exe',
    npmExecPath: 'C:\\npm-cli.js'
  }), {
    command: 'C:\\node.exe',
    argumentsList: ['C:\\npm-cli.js', 'pack', '--dry-run', '--json', '--ignore-scripts'],
    shell: false
  });
  assert.deepEqual(resolveNpmPackInvocation({ platform: 'win32', npmExecPath: '' }), {
    command: 'npm.cmd',
    argumentsList: ['pack', '--dry-run', '--json', '--ignore-scripts'],
    shell: true
  });
  assert.equal(spawnFailureDetail({ stderr: null }), '');
  assert.equal(spawnFailureDetail({ error: { code: 'ENOENT', message: 'not found' } }), 'ENOENT: not found');
});

test('package test discovery does not depend on shell glob expansion', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.test, 'node scripts/run-tests.mjs');

  const directory = mkdtempSync(path.join(os.tmpdir(), 'toolkit-test-discovery-'));
  try {
    const first = path.join(directory, 'a.test.mjs');
    const second = path.join(directory, 'b.test.mjs');
    writeFileSync(second, '');
    writeFileSync(first, '');
    writeFileSync(path.join(directory, 'not-a-test.mjs'), '');
    symlinkSync(first, path.join(directory, 'linked.test.mjs'));
    assert.deepEqual(discoverTestFiles(directory), [first, second]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the npm package excludes repository-only assets and marketplace copies', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.files.includes('skills'), false);
  assert.equal(manifest.files.includes('plugins'), false);
  for (const marketplace of ['.agents', '.claude-plugin', '.codex-plugin']) {
    assert.equal(manifest.files.includes(marketplace), false, `${marketplace} points at unpublished copies`);
  }
  assert.ok(manifest.files.includes('!docs/assets'));
});
