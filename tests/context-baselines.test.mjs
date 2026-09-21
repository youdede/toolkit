import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadArtifacts, orderContextRecords, ROOT } from '../scripts/lib/catalog.mjs';
import { installArtifact, planArtifactInstall, removeArtifact } from '../scripts/lib/install.mjs';

const expectedIds = [
  'context/development/code-quality/coding-style-baseline',
  'context/development/testing/testing-baseline',
  'context/operations/git/git-workflow-baseline',
  'context/security/threat-modeling/security-baseline'
];

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function withTempDirectory(prefix, fn) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  try { return fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('context baselines have deterministic precedence and exact provenance coverage', () => {
  const records = loadArtifacts();
  const contexts = orderContextRecords(records);
  assert.deepEqual(contexts.map(({ manifest }) => manifest.id), expectedIds);
  assert.deepEqual(contexts.map(({ manifest }) => manifest.context.precedence), [100, 200, 800, 900]);
  for (const { manifest } of contexts) {
    const provenance = [...manifest.context.provenance].sort();
    const used = [...new Set(manifest.context.rules.map((rule) => rule.sourceArtifactId))].sort();
    assert.deepEqual(used, provenance, manifest.id);
  }
});

test('generated target contexts carry native scope metadata and catalog source text', () => {
  const records = loadArtifacts();
  const byId = new Map(records.map((record) => [record.manifest.id, record.manifest]));
  for (const record of orderContextRecords(records)) {
    for (const [target, adapter] of Object.entries(record.adapters)) {
      const source = adapter.data.files[0].from;
      const rendered = readFileSync(path.join(record.directory, source), 'utf8');
      if (record.manifest.context.scope === 'glob') {
        if (target === 'claude-code') assert.match(rendered, /^---\npaths:/);
        if (target === 'cursor') assert.match(rendered, /\nalwaysApply: false\n/);
        if (target === 'github-copilot') assert.match(rendered, /^---\napplyTo:/);
      }
      for (const rule of record.manifest.context.rules) {
        const origin = byId.get(rule.sourceArtifactId);
        const text = rule.sourceField === 'summary' ? origin.summary : origin.refuses[rule.sourceIndex];
        assert.ok(rendered.includes(text), `${target}/${record.manifest.slug} omits ${rule.id}`);
      }
    }
  }
});

test('context generation is reproducible', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-contexts.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /4 generated contexts are current/);
});

test('contexts install and remove independently without leaving rule files', () => withTempDirectory('contexts-install-', (project) => {
  for (const id of expectedIds) installArtifact(id, { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
  for (const id of expectedIds) {
    const record = loadArtifacts().find(({ manifest }) => manifest.id === id);
    const relative = record.adapters['claude-code'].data.files[0].to;
    assert.ok(existsSync(path.join(project, '.claude', relative)));
  }
  for (const id of expectedIds) removeArtifact(id, { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
  assert.ok(!existsSync(path.join(project, '.claude', 'rules', 'youdede')));
}));

test('expired contexts warn without refusing install', () => withTempDirectory('contexts-expiry-', (project) => {
  const options = { root: ROOT, target: 'claude-code', scope: 'project', cwd: project, now: new Date('2028-01-01T00:00:00Z') };
  const planned = planArtifactInstall('coding-style-baseline', options);
  assert.match(planned.warnings[0], /expired on 2027-09-21/);
  const installed = installArtifact('coding-style-baseline', options);
  assert.match(installed.warnings[0], /review its provenance/);
}));

test('install-set validation names a context rule contradicted by a hook', () => withTempDirectory('contexts-conflict-', (root) => {
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  const hookDirectory = path.join(root, 'artifacts', 'hooks', 'development', 'workflow', 'deny-direct-publish');
  const contextDirectory = path.join(root, 'artifacts', 'contexts', 'development', 'workflow', 'require-direct-publish');
  for (const directory of [hookDirectory, contextDirectory]) {
    mkdirSync(path.join(directory, 'adapters'), { recursive: true });
    writeFileSync(path.join(directory, 'payload.md'), '# fixture\n');
  }
  const common = (kind, slug) => ({
    schemaVersion: 1,
    id: `${kind}/development/workflow/${slug}`,
    slug,
    name: slug,
    version: '1.0.0',
    kind,
    summary: 'Fixture summary long enough for the installer.',
    description: 'Fixture description long enough for the installer conflict test.',
    domain: 'development', category: 'workflow', capabilities: ['enforce'], problems: ['workflow-delegation'],
    frameworks: ['agnostic'], languages: ['agnostic'], lifecycle: ['implementation'], risk: 'low', license: 'MIT', authors: ['Youdede'],
    refuses: ['One sufficiently long refusal statement.', 'Another sufficiently long refusal statement.', 'A third sufficiently long refusal statement.'],
    execution: { mode: 'prompt', entrypoints: [] },
    relationships: { composesWith: [], conflictsWith: [], supersedes: [], prerequisites: [], packIds: [] },
    operational: { behavior: 'advisory', failurePolicy: 'stop-and-report', latencyClass: 'immediate', dataRetention: 'none' },
    adapters: { 'claude-code': 'adapters/claude-code.json' }
  });
  writeJson(path.join(hookDirectory, 'artifact.json'), {
    ...common('hook', 'deny-direct-publish'),
    hookGuard: { blockedActions: ['publish-directly'] }
  });
  writeJson(path.join(contextDirectory, 'artifact.json'), {
    ...common('context', 'require-direct-publish'),
    context: {
      scope: 'always', precedence: 10, provenance: ['hook/development/workflow/deny-direct-publish'],
      rules: [{ id: 'publish-now', effect: 'require', action: 'publish-directly', sourceArtifactId: 'hook/development/workflow/deny-direct-publish', sourceField: 'summary' }]
    }
  });
  for (const [directory, slug] of [[hookDirectory, 'deny-direct-publish'], [contextDirectory, 'require-direct-publish']]) {
    writeJson(path.join(directory, 'adapters', 'claude-code.json'), {
      schemaVersion: 1, target: 'claude-code', scopes: ['project'], files: [{ from: 'payload.md', to: `rules/${slug}.md` }]
    });
  }
  installArtifact('deny-direct-publish', { root, target: 'claude-code', scope: 'project', cwd: project });
  assert.throws(
    () => installArtifact('require-direct-publish', { root, target: 'claude-code', scope: 'project', cwd: project }),
    /context rule 'publish-now'.*requires 'publish-directly'.*deny-direct-publish blocks it/
  );
  const reverseProject = path.join(root, 'reverse-project');
  mkdirSync(reverseProject, { recursive: true });
  installArtifact('require-direct-publish', { root, target: 'claude-code', scope: 'project', cwd: reverseProject });
  assert.throws(
    () => installArtifact('deny-direct-publish', { root, target: 'claude-code', scope: 'project', cwd: reverseProject }),
    /context rule 'publish-now'.*requires 'publish-directly'.*deny-direct-publish blocks it/
  );
}));
