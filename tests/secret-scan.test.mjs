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

test('secret rules share one list and cover every published format', async () => {
  const shared = await import('../scripts/lib/shared-hook/secret-rules.mjs');
  const join = (...parts) => parts.join('');
  const samples = {
    PRIVATE_KEY: ['PGP PRIVATE KEY BLOCK', 'ENCRYPTED PRIVATE KEY', 'PRIVATE KEY'].map((header) => join('-----', 'BEGIN ', header, '-----')),
    GITHUB_FINE_GRAINED_TOKEN: [join('github', '_pat_', 'A'.repeat(22), '_', 'b'.repeat(59))],
    NPM_TOKEN: [join('npm', '_', 'a'.repeat(36))],
    GITLAB_TOKEN: [join('glpat', '-', 'a'.repeat(20))],
    GOOGLE_API_KEY: [join('AI', 'za', 'b'.repeat(34), '-')],
    HUGGINGFACE_TOKEN: [join('hf', '_', 'c'.repeat(34))]
  };
  for (const [ruleId, values] of Object.entries(samples)) {
    for (const value of values) assert.deepEqual(scanSecretText('f.txt', `key = "${value}"`).map((finding) => finding.ruleId), [ruleId], value);
  }
  for (const hook of ['commit-guard/targets/claude-code/commit-guard.mjs', 'prompt-secret-guard/targets/claude-code/prompt-secret-guard.mjs']) {
    const embedded = await import(`../artifacts/hooks/security/secrets/${hook}`);
    assert.deepEqual(embedded.SECRET_RULES.map(({ id, pattern }) => [id, String(pattern)]), shared.SECRET_RULES.map(({ id, pattern }) => [id, String(pattern)]), hook);
  }
  assert.deepEqual(scanSecretText('f.txt', 'sk-dashboard-components-v2-legacy'), []);

  // One real-shaped value per family, assembled so this file holds none.
  const families = {
    AWS_ACCESS_KEY: join('AK', 'IA', 'IOSFODNN7EXAMPLE'),
    GOOGLE_OAUTH_CLIENT_SECRET: join('GOC', 'SPX-', 'a1B2c3D4'.repeat(3), 'e5F6'),
    DIGITALOCEAN_TOKEN: join('do', 'p_v1_', 'ab12'.repeat(16)),
    DOCKER_HUB_TOKEN: join('dckr', '_pat_', 'aB3'.repeat(9)),
    VAULT_TOKEN: join('hv', 's.', 'aB3_'.repeat(24)),
    SLACK_WEBHOOK: join('hooks.slack', '.com/services/', 'T0AB12CD3', '/', 'B0AB12CD3', '/', 'aB3d'.repeat(6)),
    TELEGRAM_BOT_TOKEN: join('123456789', ':AA', 'Fh3k'.repeat(8), 'x'),
    STRIPE_WEBHOOK_SECRET: join('wh', 'sec_', 'aB3d'.repeat(8)),
    OPENROUTER_KEY: join('sk-', 'or-v1-', 'ab12'.repeat(16)),
    ANTHROPIC_KEY: join('sk-', 'ant-api03-', 'Ab1-'.repeat(23), 'xAA'),
    GROQ_KEY: join('gs', 'k_', 'aB3d'.repeat(13))
  };
  for (const [ruleId, value] of Object.entries(families)) {
    assert.deepEqual(scanSecretText('f.txt', `value: "${value}"`).map((finding) => finding.ruleId), [ruleId], ruleId);
  }
  // Shapes that are not credentials by themselves, or are public samples, stay clear.
  for (const text of [
    'da39a3ee5e6b4b0d3255bfef95601890afd80709', `0x${'ab'.repeat(32)}`, '123e4567-e89b-12d3-a456-426614174000',
    join('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
    join('sk_', 'test_', '4eC39HqLyjWDarjtT1zdp7dc'), `integrity sha512-${'A'.repeat(86)}==`, `node@sha256:${'f'.repeat(64)}`,
    '-----BEGIN PUBLIC KEY-----', '-----BEGIN CERTIFICATE-----', 'process.env.GITHUB_TOKEN', 'API-VERSION-2024-01-01'
  ]) assert.deepEqual(scanSecretText('f.txt', text), [], text);
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
