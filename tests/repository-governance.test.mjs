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

  const breaking = evaluateCommitMessage('feat!: remove compatibility alias');
  assert.equal(breaking.valid, false);
  assert.ok(breaking.violations.some(({ rule }) => rule === 'COMMIT_BREAKING_FOOTER'));
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
