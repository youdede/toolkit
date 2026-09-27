import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzePackWorkflow, loadPacks, publicPackCatalog, validatePack, validateRepository, ROOT } from '../scripts/lib/catalog.mjs';
import { doctor, installArtifact, installPack, planPackInstall, removeArtifact, removePack } from '../scripts/lib/install.mjs';

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createCollidingPackRepository(root) {
  for (const slug of ['first-member', 'second-member']) {
    const artifactDirectory = path.join(root, 'artifacts', slug);
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(path.join(artifactDirectory, 'payload.md'), `${slug}\n`);
    writeJson(path.join(artifactDirectory, 'adapter.json'), {
      schemaVersion: 1,
      target: 'claude-code',
      scopes: ['project'],
      files: [{ from: 'payload.md', to: 'skills/shared-destination/SKILL.md' }]
    });
    writeJson(path.join(artifactDirectory, 'artifact.json'), {
      schemaVersion: 1,
      id: `skill/development/testing/${slug}`,
      slug,
      version: '1.0.0',
      kind: 'skill',
      adapters: { 'claude-code': 'adapter.json' }
    });
  }
  writeJson(path.join(root, 'packs', 'collision-pack', 'pack.json'), {
    schemaVersion: 1,
    id: 'pack/collision-pack',
    slug: 'collision-pack',
    members: [
      { artifactId: 'skill/development/testing/first-member', required: true },
      { artifactId: 'skill/development/testing/second-member', required: true }
    ]
  });
}

function writeHookArtifact(root, slug, description) {
  const artifactDirectory = path.join(root, 'artifacts', slug);
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(path.join(artifactDirectory, `${slug}.mjs`), `#!/usr/bin/env node\nprocess.exit(0);\n`);
  writeJson(path.join(artifactDirectory, 'adapter.json'), {
    schemaVersion: 1,
    target: 'claude-code',
    scopes: ['project'],
    files: [{ from: `${slug}.mjs`, to: `hooks/youdede/${slug}.mjs`, executable: true }],
    settingsPatch: {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          description,
          hooks: [{ type: 'command', command: `{claudeRoot}/hooks/youdede/${slug}.mjs`, timeout: 5 }]
        }]
      }
    }
  });
  writeJson(path.join(artifactDirectory, 'artifact.json'), {
    schemaVersion: 1,
    id: `hook/operations/testing/${slug}`,
    slug,
    version: '1.0.0',
    kind: 'hook',
    adapters: { 'claude-code': 'adapter.json' }
  });
}

function writeRollbackPack(root, members) {
  writeJson(path.join(root, 'packs', 'rollback-pack', 'pack.json'), {
    schemaVersion: 1,
    id: 'pack/rollback-pack',
    slug: 'rollback-pack',
    members: members.map((artifactId) => ({ artifactId, required: true }))
  });
}

test('composition packs resolve valid cross-kind members and common targets', () => {
  const { packs, packResults } = validateRepository();
  assert.ok(packs.length >= 5);
  assert.deepEqual(packResults.flatMap(({ record, errors }) => errors.map((error) => `${record.manifest.id}: ${error}`)), []);
  for (const { manifest } of loadPacks()) {
    assert.ok(new Set(manifest.members.map(({ artifactId }) => artifactId.split('/')[0])).size >= 2, manifest.id);
  }
  const publicPacks = JSON.parse(readFileSync(path.join(ROOT, 'catalog', 'packs.json'), 'utf8'));
  for (const pack of publicPacks.packs) {
    assert.ok(pack.hookFanout.every(({ count }) => count <= 3), pack.id);
  }
});

test('published packs meet conservative workflow promotion criteria', () => {
  const repository = validateRepository();
  const catalog = publicPackCatalog(repository.packs, repository.artifacts, 'test');
  assert.equal(catalog.count, repository.packs.length);
  for (const pack of catalog.packs) {
    assert.equal(pack.promotion.eligible, true, pack.id);
    assert.ok(pack.promotion.criteria.requiredProcedure, pack.id);
    assert.ok(pack.promotion.criteria.independentRequiredAssurance, pack.id);
    assert.ok(pack.promotion.criteria.compositionConnected, pack.id);
    assert.ok(pack.promotion.criteria.prerequisiteClosed, pack.id);
    assert.ok(pack.targets.length > 0, pack.id);
    for (const target of pack.targets) assert.ok(pack.targetCompatibility[target].scopes.length > 0, `${pack.id}:${target}`);
  }

  const infrastructure = catalog.packs.find(({ id }) => id === 'pack/infrastructure-change-readiness');
  assert.deepEqual(infrastructure.targets, ['claude-code', 'gemini-cli', 'github-copilot', 'opencode']);
  assert.equal(infrastructure.promotion.roleCounts.procedure, 1);
  assert.equal(infrastructure.promotion.roleCounts.specialist, 1);
  assert.equal(infrastructure.promotion.roleCounts.verifier, 1);
});

test('pack promotion rejects incomplete roles, disconnected members, prerequisite gaps, and incompatible scopes', () => {
  const repository = validateRepository();
  const source = loadPacks().find(({ manifest }) => manifest.id === 'pack/infrastructure-change-readiness');
  const knownIds = new Set(repository.artifacts.map(({ manifest }) => manifest.id));
  const check = (manifest, artifacts = repository.artifacts) => validatePack(
    { ...source, manifest },
    knownIds,
    artifacts
  );

  const noProcedure = structuredClone(source.manifest);
  noProcedure.members[0].role = 'verifier';
  assert.ok(check(noProcedure).some((error) => /requires a required procedure skill/.test(error)));

  const disconnected = structuredClone(source.manifest);
  disconnected.members[2].artifactId = 'subagent/data/databases/query-plan-analyst';
  assert.ok(check(disconnected).some((error) => /composesWith-connected workflow/.test(error)));

  const prerequisiteArtifacts = structuredClone(repository.artifacts);
  const procedure = prerequisiteArtifacts.find(({ manifest }) => manifest.id === disconnected.members[0].artifactId);
  procedure.manifest.relationships.prerequisites = ['skill/development/testing/plan-load-test'];
  assert.ok(check(source.manifest, prerequisiteArtifacts).some((error) => /needs required prerequisite/.test(error)));

  const scopeArtifacts = structuredClone(repository.artifacts);
  const procedureRecord = scopeArtifacts.find(({ manifest }) => manifest.id === source.manifest.members[0].artifactId);
  const specialistRecord = scopeArtifacts.find(({ manifest }) => manifest.id === source.manifest.members[1].artifactId);
  for (const adapter of Object.values(procedureRecord.adapters)) adapter.data.scopes = ['project'];
  for (const adapter of Object.values(specialistRecord.adapters)) adapter.data.scopes = ['user'];
  const scopeWorkflow = analyzePackWorkflow(source.manifest, scopeArtifacts);
  assert.equal(scopeWorkflow.criteria.compatibleInstallCoordinate, false);
  assert.ok(check(source.manifest, scopeArtifacts).some((error) => /no common installation target and scope/.test(error)));

  const optionalManifest = structuredClone(source.manifest);
  optionalManifest.members[2].required = false;
  const optionalArtifacts = structuredClone(repository.artifacts);
  const optionalRecord = optionalArtifacts.find(({ manifest }) => manifest.id === optionalManifest.members[2].artifactId);
  optionalRecord.adapters.opencode.data.scopes = ['user'];
  const optionalWorkflow = analyzePackWorkflow(optionalManifest, optionalArtifacts);
  const opencode = optionalWorkflow.compatibility.find(({ target }) => target === 'opencode');
  assert.deepEqual(opencode.optionalUnsupported, []);
  assert.deepEqual(opencode.optionalUnsupportedByScope.project, [optionalManifest.members[2].artifactId]);
  assert.deepEqual(opencode.optionalUnsupportedByScope.user, []);
});

test('pack install is one operation while direct ownership survives pack removal', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const result = installPack('accessibility-assurance', { cwd: directory });
  const memberCount = result.pack.members.length;
  assert.equal(result.installed.length, memberCount);
  assert.equal(doctor({ cwd: directory }).installs, memberCount);

  installArtifact('test-screen-reader-journey', { cwd: directory });
  removePack('accessibility-assurance', { cwd: directory });
  assert.equal(doctor({ cwd: directory }).installs, 1);
  assert.ok(existsSync(path.join(directory, '.claude', 'skills', 'test-screen-reader-journey', 'SKILL.md')));

  removeArtifact('test-screen-reader-journey', { cwd: directory });
  assert.equal(doctor({ cwd: directory }).installs, 0);
});

test('pack planning rejects an unsupported required target before writing', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-target-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(
    () => planPackInstall('accessibility-assurance', { cwd: directory, target: 'codex' }),
    /required member.*cannot install for codex/
  );
  assert.equal(existsSync(path.join(directory, '.agents')), false);
});

test('pack install collision is detected before earlier members are written', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-collision-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const agents = path.join(directory, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(path.join(agents, 'release-risk-reviewer.md'), 'unmanaged\n');

  assert.throws(() => installPack('release-readiness', { cwd: directory }), /already exists and is unmanaged/);
  assert.equal(existsSync(path.join(directory, '.claude', 'skills', 'verify-production-release', 'SKILL.md')), false);
  assert.equal(readFileSync(path.join(agents, 'release-risk-reviewer.md'), 'utf8'), 'unmanaged\n');
});

test('pack planning rejects collisions between members before any mutation', (context) => {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-overlap-repo-'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-overlap-target-'));
  context.after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  createCollidingPackRepository(repository);

  assert.throws(
    () => installPack('collision-pack', { root: repository, cwd: directory }),
    /both mutate 'skills[\\/]shared-destination[\\/]SKILL\.md'/
  );
  assert.equal(existsSync(path.join(directory, '.claude')), false);
});

test('failed pack upgrade restores the exact pre-existing installation', (context) => {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-rollback-repo-'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-rollback-target-'));
  context.after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  const firstId = 'hook/operations/testing/first-hook';
  const secondId = 'hook/operations/testing/second-hook';
  writeHookArtifact(repository, 'first-hook', '[youdede:first-hook] original entry');
  writeRollbackPack(repository, [firstId]);
  installPack('rollback-pack', { root: repository, cwd: directory });

  const settingsFile = path.join(directory, '.claude', 'settings.json');
  const stateFile = path.join(directory, '.claude', '.youdede-toolkit', 'state.json');
  const firstScript = path.join(directory, '.claude', 'hooks', 'youdede', 'first-hook.mjs');
  const noticeFile = path.join(directory, '.claude', '.youdede-toolkit', 'NOTICE.md');
  const before = {
    settings: readFileSync(settingsFile),
    state: readFileSync(stateFile),
    script: readFileSync(firstScript),
    notice: readFileSync(noticeFile)
  };

  writeHookArtifact(repository, 'first-hook', '[youdede:shared-upgrade] colliding entry');
  writeHookArtifact(repository, 'second-hook', '[youdede:shared-upgrade] colliding entry');
  writeRollbackPack(repository, [firstId, secondId]);

  assert.throws(
    () => installPack('rollback-pack', { root: repository, cwd: directory }),
    /installation failed: settings contain a modified or unmanaged/
  );
  assert.deepEqual(readFileSync(settingsFile), before.settings);
  assert.deepEqual(readFileSync(stateFile), before.state);
  assert.deepEqual(readFileSync(firstScript), before.script);
  assert.deepEqual(readFileSync(noticeFile), before.notice);
  assert.equal(existsSync(path.join(directory, '.claude', 'hooks', 'youdede', 'second-hook.mjs')), false);
  assert.equal(doctor({ cwd: directory }).findings.length, 0);
});

test('failed first pack install removes the notice it generated (PR38-CODEX4-4)', (context) => {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-notice-repo-'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-notice-target-'));
  context.after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  writeHookArtifact(repository, 'first-hook', '[youdede:shared-marker] colliding entry');
  writeHookArtifact(repository, 'second-hook', '[youdede:shared-marker] colliding entry');
  writeRollbackPack(repository, ['hook/operations/testing/first-hook', 'hook/operations/testing/second-hook']);

  assert.throws(
    () => installPack('rollback-pack', { root: repository, cwd: directory }),
    /installation failed: settings contain a modified or unmanaged/
  );
  assert.equal(existsSync(path.join(directory, '.claude', '.youdede-toolkit', 'NOTICE.md')), false);
  assert.equal(existsSync(path.join(directory, '.claude', 'hooks', 'youdede', 'first-hook.mjs')), false);
});

test('pack removal follows recorded ownership after the pack manifest changes', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-evolution-target-'));
  const repository = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-evolution-repo-'));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  });

  const installed = installPack('accessibility-assurance', { cwd: directory });
  const changedPack = structuredClone(installed.pack);
  changedPack.members = changedPack.members.slice(-1);
  writeJson(path.join(repository, 'packs', changedPack.slug, 'pack.json'), changedPack);

  const removed = removePack('accessibility-assurance', { cwd: directory, root: repository });
  assert.equal(removed.removed.length, installed.pack.members.length);
  assert.equal(doctor({ cwd: directory }).installs, 0);
});

test('a removed pack definition remains uninstallable from recorded ownership', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-retired-target-'));
  const emptyRepository = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-retired-repo-'));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(emptyRepository, { recursive: true, force: true });
  });

  const installed = installPack('reviewable-change', { cwd: directory });
  const removed = removePack('reviewable-change', { cwd: directory, root: emptyRepository });
  assert.equal(removed.pack.version, 'unavailable');
  assert.equal(removed.removed.length, installed.pack.members.length);
  assert.equal(doctor({ cwd: directory }).installs, 0);
});

test('pack CLI exposes list, info, and machine-readable dry-run', () => {
  const run = (args) => spawnSync(process.execPath, ['./bin/youdede-toolkit.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
  const list = run(['packs']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /accessibility-assurance/);
  const info = run(['pack-info', 'release-readiness']);
  assert.equal(info.status, 0, info.stderr);
  assert.match(info.stdout, /Release readiness 1\.1\.0/);
  assert.match(info.stdout, /Evidence: ledger-linked/);
  assert.match(info.stdout, /hook\/operations\/repository-state\/release-clean-state-guard/);
  assert.match(info.stdout, /Hook fan-out: .*PreToolUse:Bash=3/);
  const dry = run(['add-pack', 'reviewable-change', '--dry-run', '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.pack.id, 'pack/reviewable-change');
  assert.ok(plan.members.every((item) => item.plan));
});
