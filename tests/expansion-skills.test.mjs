import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifySqlRisks } from '../artifacts/skills/data/migrations/review-database-migration-plan/scripts/classify-sql-risks.mjs';
import { collectWorkflowSignals } from '../artifacts/skills/operations/ci-cd/review-ci-workflow-change/scripts/collect-workflow-signals.mjs';
import { collectReleaseEvidence } from '../artifacts/skills/writing/release-notes/write-release-notes-from-evidence/scripts/collect-release-evidence.mjs';
import { cleanGitEnvironment } from './git-env.mjs';

test('SQL risk helper emits only stable explicit risk IDs and rejects oversized input', () => {
  const result = classifySqlRisks('ALTER TABLE accounts DROP COLUMN legacy_id;\nTRUNCATE TABLE audit_log;');
  assert.deepEqual(result.findings.map((item) => item.ruleId), ['MIG_SQL_DROP_COLUMN', 'MIG_SQL_TRUNCATE']);
  assert.throws(() => classifySqlRisks('x'.repeat(256 * 1024 + 1)), /exceeds/);
  assert.deepEqual(classifySqlRisks('SELECT * FROM accounts;').findings, []);
});

test('SQL risk helper masks inert text, handles comment gaps, EOF statements, and repeated findings', () => {
  const inert = classifySqlRisks("-- DROP TABLE users;\nSELECT 'TRUNCATE audit', \"DROP TABLE\";");
  assert.deepEqual(inert.findings, []);
  const result = classifySqlRisks([
    'DROP /* reviewed separately */ TABLE old_events;',
    'DELETE FROM sessions',
    '; UPDATE accounts SET active = false;',
    'DROP TABLE first_archive; DROP TABLE second_archive;'
  ].join('\n'));
  assert.deepEqual(result.findings.map(({ ruleId }) => ruleId), [
    'MIG_SQL_DROP_TABLE',
    'MIG_SQL_DELETE_WITHOUT_WHERE',
    'MIG_SQL_UPDATE_WITHOUT_WHERE',
    'MIG_SQL_DROP_TABLE',
    'MIG_SQL_DROP_TABLE'
  ]);
});

test('SQL risk helper follows PostgreSQL standard_conforming_strings for backslashes', () => {
  const ids = (sql) => classifySqlRisks(sql).findings.map(({ ruleId, line }) => `${ruleId}@${line}`);
  // Backslash is literal in '...', so the string ends at the second quote and DROP TABLE is visible.
  assert.deepEqual(ids("INSERT INTO paths VALUES ('C:\\');\nDROP TABLE users;\nINSERT INTO paths VALUES ('x');"), ['MIG_SQL_DROP_TABLE@2']);
  // In an E'...' escape string \' does not close the string.
  assert.deepEqual(ids("SELECT E'it\\'s DROP TABLE x';\nSELECT 1;"), []);
  assert.deepEqual(ids('SELECT "C:\\";\nDROP TABLE users;'), ['MIG_SQL_DROP_TABLE@2']);
});

test('SQL risk helper checks UPDATE and DELETE for a WHERE at their own level', () => {
  const ids = (sql) => classifySqlRisks(sql).findings.map(({ ruleId, line }) => `${ruleId}@${line}`);
  assert.deepEqual(ids('ALTER TABLE o ADD CONSTRAINT fk FOREIGN KEY (c) REFERENCES c(id) ON UPDATE SET NULL;'), []);
  assert.deepEqual(ids('SELECT * FROM t FOR NO KEY UPDATE;'), []);
  assert.deepEqual(ids('UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1);'), ['MIG_SQL_UPDATE_WITHOUT_WHERE@1']);
  assert.deepEqual(ids('DELETE FROM t USING (SELECT id FROM u WHERE u.x) s;'), ['MIG_SQL_DELETE_WITHOUT_WHERE@1']);
  assert.deepEqual(ids('UPDATE accounts SET flag = true WHERE id IN (SELECT id FROM x WHERE y);'), []);
  assert.deepEqual(ids('WITH moved AS (UPDATE t SET a = 1 WHERE b RETURNING id) SELECT * FROM moved;'), []);
  assert.deepEqual(ids('WITH moved AS (UPDATE t SET a = 1 RETURNING id) SELECT * FROM moved WHERE id > 0;'), ['MIG_SQL_UPDATE_WITHOUT_WHERE@1']);
});

test('workflow collector reports literal lines without YAML execution or semantic parsing', () => {
  const result = collectWorkflowSignals('on: pull_request\npermissions:\n  contents: write\nsteps:\n  - uses: actions/checkout@v4\n  - run: npm test\n  - run: echo ${{ secrets.TOKEN }}');
  assert.equal(result.parser, 'line-signal-collector');
  assert.ok(result.signals.some((item) => item.type === 'action-reference'));
  assert.ok(result.signals.some((item) => item.type === 'secret-reference'));
  assert.throws(() => collectWorkflowSignals('x'.repeat(512 * 1024 + 1)), /exceeds/);
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('workflow collector reports block triggers, inherited secrets, token use, read permissions, and run bodies', () => {
  const workflow = [
    '"on":',
    '  pull_request_target:',
    '    branches: [main]',
    'permissions:',
    '  contents: read',
    '  id-token: write',
    'jobs:',
    '  call:',
    '    uses: org/repo/.github/workflows/r.yml@v1',
    '    secrets: inherit',
    '  build:',
    '    steps:',
    '      - name: Pre-run: check',
    '        run: |',
    '          curl -H "Authorization: ${{ github.token }}" https://x',
    '          make deploy',
    '      - uses: actions/checkout@v4'
  ].join('\n');
  const got = collectWorkflowSignals(workflow).signals.map(({ line, type }) => `${line}:${type}`);
  assert.deepEqual(got, [
    '1:event-declaration', '2:event-declaration',
    '4:permission-declaration', '5:permission-declaration', '6:permission-declaration',
    '9:action-reference', '10:secret-reference',
    '14:run-command', '15:secret-reference', '16:run-command',
    '17:action-reference'
  ]);
});

test('release collector reads an explicit bounded Git range without mutation', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'release-evidence-'));
  try {
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(directory, 'notes.txt'), 'first\n');
    git(directory, ['add', 'notes.txt']); git(directory, ['commit', '-m', 'first change']);
    const from = git(directory, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(directory, 'notes.txt'), 'second\n');
    git(directory, ['commit', '-am', 'second change']);
    const result = collectReleaseEvidence({ cwd: directory, from, to: 'HEAD' });
    assert.equal(result.commits.length, 1);
    assert.deepEqual(result.changedFiles, ['M\tnotes.txt']);
    assert.throws(() => collectReleaseEvidence({ cwd: directory, from: 'missing', to: 'HEAD' }), /fatal|ambiguous|unknown/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('release collector truncates a range whose file list exceeds 1 MiB instead of failing', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'release-evidence-large-'));
  try {
    git(directory, ['init']);
    git(directory, ['config', 'user.email', 'test@example.invalid']);
    git(directory, ['config', 'user.name', 'Test']);
    git(directory, ['commit', '--allow-empty', '-m', 'base']);
    const from = git(directory, ['rev-parse', 'HEAD']);
    for (let index = 0; index < 6000; index += 1) writeFileSync(path.join(directory, `f${String(index).padStart(5, '0')}${'x'.repeat(190)}.txt`), 'x\n');
    git(directory, ['add', '.']); git(directory, ['commit', '-q', '-m', 'many files']);
    const result = collectReleaseEvidence({ cwd: directory, from, to: 'HEAD' });
    assert.equal(result.changedFiles.length, 200);
    assert.equal(result.changedFilesTruncated, true);
    assert.ok(result.diffStat.split('\n').length <= 202);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
