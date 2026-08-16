import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifySqlRisks } from '../artifacts/skills/data/migrations/review-database-migration-plan/scripts/classify-sql-risks.mjs';
import { collectWorkflowSignals } from '../artifacts/skills/operations/ci-cd/review-ci-workflow-change/scripts/collect-workflow-signals.mjs';
import { collectReleaseEvidence } from '../artifacts/skills/writing/release-notes/write-release-notes-from-evidence/scripts/collect-release-evidence.mjs';

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

test('workflow collector reports literal lines without YAML execution or semantic parsing', () => {
  const result = collectWorkflowSignals('on: pull_request\npermissions:\n  contents: write\nsteps:\n  - uses: actions/checkout@v4\n  - run: npm test\n  - run: echo ${{ secrets.TOKEN }}');
  assert.equal(result.parser, 'line-signal-collector');
  assert.ok(result.signals.some((item) => item.type === 'action-reference'));
  assert.ok(result.signals.some((item) => item.type === 'secret-reference'));
  assert.throws(() => collectWorkflowSignals('x'.repeat(512 * 1024 + 1)), /exceeds/);
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

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
