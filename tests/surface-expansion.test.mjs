import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, validateRepository } from '../scripts/lib/catalog.mjs';
import { installArtifact } from '../scripts/lib/install.mjs';

const expanded = [
  'command/operations/ci-cd/diagnose-ci-failure',
  'command/development/agent-tooling/preflight-change-environment',
  'command/development/agent-tooling/audit-repository-instructions',
  'context/development/api/api-contract-baseline',
  'context/data/migrations/database-migration-baseline',
  'context/operations/ci-cd/ci-workflow-baseline',
  'context/security/dependencies/dependency-change-baseline'
];

test('the expanded workflow surface is structurally valid and behaviorally covered', () => {
  const repository = validateRepository(ROOT);
  const byId = new Map(repository.artifacts.map((record) => [record.manifest.id, record]));
  for (const id of expanded) {
    const record = byId.get(id);
    assert.ok(record, id);
    const failures = repository.results.find(({ record: candidate }) => candidate.manifest.id === id)?.errors ?? [];
    assert.deepEqual(failures, [], `${id}: ${failures.join('\n')}`);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(record.directory, 'evaluations/behavioral.json'), 'utf8')));
  }
});

test('new contexts occupy the intended precedence band with exact provenance coverage', () => {
  const repository = validateRepository(ROOT);
  const contexts = repository.artifacts.filter(({ manifest }) => expanded.includes(manifest.id) && manifest.kind === 'context');
  assert.deepEqual(contexts.map(({ manifest }) => manifest.context.precedence).sort((a, b) => a - b), [300, 400, 500, 600]);
  for (const { manifest } of contexts) {
    assert.deepEqual(new Set(manifest.context.provenance), new Set(manifest.context.rules.map(({ sourceArtifactId }) => sourceArtifactId)));
  }
});

test('the environment collector emits bounded redacted JSON', () => {
  const file = path.join(ROOT, 'artifacts/commands/development/agent-tooling/preflight-change-environment/scripts/collect-environment.mjs');
  const run = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'runtime', 'repository', 'markers']);
  assert.equal(JSON.stringify(result).includes(ROOT), false);
  assert.equal(JSON.stringify(result).includes('remote'), false);
  assert.equal(Object.hasOwn(result, 'env'), false);
});

test('positive command wrappers run check-preconditions.mjs before bounded work', (context) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'youdede-expanded-commands-'));
  context.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.claude'), { recursive: true });
  for (const slug of ['audit-repository-instructions', 'preflight-change-environment', 'diagnose-ci-failure']) {
    installArtifact(slug, { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
    const relative = `.claude/commands/youdede/${slug}/check-preconditions.mjs`;
    const run = spawnSync(process.execPath, [path.join(project, relative)], { cwd: project, encoding: 'utf8' });
    assert.equal(run.status, 0, `${relative}: ${run.stdout}${run.stderr}`);
    assert.equal(JSON.parse(run.stdout).ok, true);
  }
});

test('negative collection never enumerates process environment values', () => {
  const file = path.join(ROOT, 'artifacts/commands/development/agent-tooling/preflight-change-environment/scripts/collect-environment.mjs');
  const run = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, YOUDEDE_SENTINEL_SECRET: 'must-not-appear' } });
  assert.equal(run.stdout.includes('must-not-appear'), false);
  assert.equal(run.stdout.includes('YOUDEDE_SENTINEL_SECRET'), false);
});

test('malformed extra collector input cannot widen the snapshot', () => {
  const file = path.join(ROOT, 'artifacts/commands/development/agent-tooling/preflight-change-environment/scripts/collect-environment.mjs');
  const normal = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8' });
  const malformed = spawnSync(process.execPath, [file, '--print-env', '--remote', 'origin'], { cwd: ROOT, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(malformed.stdout), JSON.parse(normal.stdout));
});

test('boundary snapshot contains no absolute workspace path or remote URL', () => {
  const file = path.join(ROOT, 'artifacts/commands/development/agent-tooling/preflight-change-environment/scripts/collect-environment.mjs');
  const run = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.stdout.includes(ROOT), false);
  assert.doesNotMatch(run.stdout, /https?:\/\//);
});
