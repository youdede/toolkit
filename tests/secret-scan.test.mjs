import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isSensitivePath,
  scanGitHistory,
  scanSecretText,
  scanWorkspacePaths
} from '../scripts/lib/secret-scan.mjs';

function git(cwd, args) {
  const outcome = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Secret Scan Test',
      GIT_AUTHOR_EMAIL: 'secret-scan@example.invalid',
      GIT_COMMITTER_NAME: 'Secret Scan Test',
      GIT_COMMITTER_EMAIL: 'secret-scan@example.invalid'
    }
  });
  assert.equal(outcome.status, 0, outcome.stderr);
}

test('secret rules report high-confidence formats without returning matched values', () => {
  const secret = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890AB'].join('_');
  const findings = scanSecretText('fixture.txt', `before ${secret} after`);
  assert.deepEqual(findings.map(({ ruleId }) => ruleId), ['GITHUB_TOKEN']);
  assert.equal(findings[0].line, 1);
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(secret));

  assert.deepEqual(scanSecretText('safe.txt', 'Document prefixes ghp_ and sk-live without credential values.'), []);
});

test('sensitive paths are narrow and template environment files remain valid', () => {
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('config/.env.production'), true);
  assert.equal(isSensitivePath('config/.env.example'), false);
  assert.equal(isSensitivePath('docs/secrets/guide.md'), false);
  assert.equal(isSensitivePath('artifacts/security/secrets.json'), true);
});

test('workspace scanning fails closed on symlinks and redacts content', (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'youdede-secret-workspace-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = ['npm', 'A'.repeat(36)].join('_');
  writeFileSync(path.join(root, 'unsafe.js'), `export const value = "${secret}";\n`);
  writeFileSync(path.join(root, 'target.txt'), 'safe\n');
  symlinkSync(path.join(root, 'target.txt'), path.join(root, 'linked.txt'));

  const result = scanWorkspacePaths(root, [
    { path: 'unsafe.js', scopes: ['tracked', 'package'] },
    { path: 'linked.txt', scopes: ['tracked'] }
  ]);
  assert.deepEqual(result.findings.map(({ ruleId }) => ruleId).sort(), ['NPM_TOKEN', 'SYMLINK_UNSCANNED']);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('history scanning detects a secret removed from the current tree', (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'youdede-secret-history-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  const secret = ['glpat', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('-');
  writeFileSync(path.join(root, 'credential.txt'), `${secret}\n`);
  git(root, ['add', 'credential.txt']);
  git(root, ['commit', '-qm', 'add fixture']);
  writeFileSync(path.join(root, 'credential.txt'), 'removed\n');
  git(root, ['add', 'credential.txt']);
  git(root, ['commit', '-qm', 'remove fixture']);

  const result = scanGitHistory(root);
  assert.ok(result.findings.some(({ ruleId }) => ruleId === 'GITLAB_TOKEN'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});
