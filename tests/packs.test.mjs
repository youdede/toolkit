import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzePackWorkflow, loadArtifacts, loadPacks, publicPackCatalog, validatePack, validateRepository, ROOT } from '../scripts/lib/catalog.mjs';
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

// The schema is documentation nothing executes, so it once forbade the very value the validator
// requires of every pack. This reads the constraint from the schema file and applies it.
test('every pack evidence.reportSchema satisfies the constraint pack.schema.json states', () => {
  const rule = JSON.parse(readFileSync(path.join(ROOT, 'schema', 'pack.schema.json'), 'utf8')).properties.evidence.properties.reportSchema;
  assert.ok(Object.hasOwn(rule, 'const') || Object.hasOwn(rule, 'pattern'), 'reportSchema states a const or a pattern');
  const packs = loadPacks();
  assert.ok(packs.length > 0);
  for (const { manifest } of packs) {
    const value = manifest.evidence.reportSchema;
    if (Object.hasOwn(rule, 'const')) assert.equal(value, rule.const, manifest.id);
    if (Object.hasOwn(rule, 'pattern')) assert.match(value, new RegExp(rule.pattern), manifest.id);
  }
});

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

test('failed first pack install removes the notice it generated', (context) => {
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

test('failed pack removal restores the notice with state and payloads', (context) => {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-remove-repo-'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-remove-target-'));
  context.after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  const firstId = 'hook/operations/testing/first-hook';
  const secondId = 'hook/operations/testing/second-hook';
  writeHookArtifact(repository, 'first-hook', '[youdede:first-hook] first entry');
  writeHookArtifact(repository, 'second-hook', '[youdede:second-hook] second entry');
  writeRollbackPack(repository, [firstId, secondId]);
  installPack('rollback-pack', { root: repository, cwd: directory });

  // The first member's recorded hook loses its marker, so its removal fails after the second succeeds.
  const stateFile = path.join(directory, '.claude', '.youdede-toolkit', 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const first = Object.values(state.installs).find((install) => install.artifactId === firstId);
  for (const hook of first.hooks) {
    delete hook.marker;
    if (hook.entry) hook.entry = { ...hook.entry, description: 'marker removed' };
  }
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  const noticeFile = path.join(directory, '.claude', '.youdede-toolkit', 'NOTICE.md');
  const settingsFile = path.join(directory, '.claude', 'settings.json');
  const secondScript = path.join(directory, '.claude', 'hooks', 'youdede', 'second-hook.mjs');
  const before = { notice: readFileSync(noticeFile), state: readFileSync(stateFile), settings: readFileSync(settingsFile), script: readFileSync(secondScript) };
  assert.match(before.notice.toString(), /second-hook/);

  assert.throws(
    () => removePack('rollback-pack', { root: repository, cwd: directory, force: true }),
    /rollback-pack removal failed/
  );
  assert.deepEqual(readFileSync(noticeFile), before.notice);
  assert.deepEqual(readFileSync(stateFile), before.state);
  assert.deepEqual(readFileSync(settingsFile), before.settings);
  assert.deepEqual(readFileSync(secondScript), before.script);
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
  assert.match(info.stdout, /Release readiness \d+\.\d+\.\d+/);
  assert.match(info.stdout, /Evidence: ledger-linked/);
  assert.match(info.stdout, /hook\/operations\/repository-state\/release-clean-state-guard/);
  assert.match(info.stdout, /Hook fan-out: .*PreToolUse:Bash=3 \(plus prerequisite: shell-command-guard\)/);
  const dry = run(['add-pack', 'reviewable-change', '--dry-run', '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.pack.id, 'pack/reviewable-change');
  assert.ok(plan.members.every((item) => item.plan));
});

test('pack removal succeeds after installing members without prerequisites', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-order-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = path.join(ROOT, 'bin', 'youdede-toolkit.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--cwd', directory], { encoding: 'utf8' });
  installPack('daily-driver', { cwd: directory, prerequisites: false });
  const planned = run('remove-pack', 'daily-driver', '--dry-run', '--json');
  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(JSON.parse(planned.stdout).dependents, []);
  const removed = run('remove-pack', 'daily-driver');
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(doctor({ cwd: directory }).installs, 0);
});

for (const failure of ['unmanaged file', 'modified file']) {
  test(`optional pack members fail installation on a ${failure}`, (context) => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-optional-repo-'));
    const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-optional-target-'));
    context.after(() => {
      rmSync(repository, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    });
    writeHookArtifact(repository, 'optional-hook', '[youdede:optional-hook] optional entry');
    const artifactId = 'hook/operations/testing/optional-hook';
    writeJson(path.join(repository, 'packs', 'optional-pack', 'pack.json'), {
      id: 'pack/optional-pack', slug: 'optional-pack', members: [{ artifactId, required: false }]
    });
    if (failure === 'modified file') installArtifact(artifactId, { root: repository, cwd: directory });
    const script = path.join(directory, '.claude', 'hooks', 'youdede', 'optional-hook.mjs');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, 'local content\n');
    assert.throws(
      () => installPack('optional-pack', { root: repository, cwd: directory }),
      /already exists and is unmanaged|changed since installation/
    );
    assert.equal(readFileSync(script, 'utf8'), 'local content\n');
  });
}

test('optional pack members are skipped for unsupported targets and scopes', (context) => {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-optional-repo-'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-optional-target-'));
  context.after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  writeHookArtifact(repository, 'optional-hook', '[youdede:optional-hook] optional entry');
  writeJson(path.join(repository, 'packs', 'optional-pack', 'pack.json'), {
    id: 'pack/optional-pack', slug: 'optional-pack',
    members: [{ artifactId: 'hook/operations/testing/optional-hook', required: false }]
  });
  for (const options of [{ target: 'codex' }, { scope: 'user' }]) {
    const result = installPack('optional-pack', { root: repository, cwd: directory, ...options });
    assert.equal(result.skipped.length, 1);
    assert.equal(result.installed.length, 0);
  }
  assert.deepEqual(doctor({ cwd: directory }).findings, []);
});

test('failed pack install rolls back prerequisites outside the pack', (context) => {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-prerequisite-repo-'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-prerequisite-target-'));
  context.after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  writeHookArtifact(repository, 'prerequisite-hook', '[youdede:prerequisite-hook] prerequisite entry');
  writeHookArtifact(repository, 'first-hook', '[youdede:shared-marker] colliding entry');
  writeHookArtifact(repository, 'second-hook', '[youdede:shared-marker] colliding entry');
  const manifestPath = path.join(repository, 'artifacts', 'first-hook', 'artifact.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.relationships = { prerequisites: ['hook/operations/testing/prerequisite-hook'] };
  writeJson(manifestPath, manifest);
  writeRollbackPack(repository, ['hook/operations/testing/first-hook', 'hook/operations/testing/second-hook']);
  assert.throws(
    () => installPack('rollback-pack', { root: repository, cwd: directory }),
    /installation failed: settings contain a modified or unmanaged/
  );
  assert.equal(existsSync(path.join(directory, '.claude', 'hooks', 'youdede', 'prerequisite-hook.mjs')), false);
  assert.equal(existsSync(path.join(directory, '.claude', 'settings.json')), false);
  assert.equal(doctor({ cwd: directory }).installs, 0);
});

function createWorkflowFixture(context) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-flow-repo-'));
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-flow-target-'));
  context.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); });
  const entry = 'skill/development/testing/collect-review';
  const verifier = 'skill/development/testing/verify-review';
  const specialist = 'subagent/development/testing/review-verifier';
  for (const id of [entry, verifier, specialist]) {
    const slug = id.split('/').at(-1);
    const kind = id.split('/')[0];
    const directory = path.join(root, 'artifacts', slug);
    const targets = kind === 'subagent' ? ['claude-code'] : ['claude-code', 'codex', 'cursor'];
    writeJson(path.join(directory, 'artifact.json'), {
      schemaVersion: 1, id, slug, name: slug, version: '1.0.0', kind,
      relationships: { composesWith: [entry, verifier, specialist].filter((other) => other !== id), prerequisites: [], conflictsWith: [], supersedes: [] },
      adapters: Object.fromEntries(targets.map((target) => [target, `${target}.json`]))
    });
    writeFileSync(path.join(directory, 'payload.md'), `${slug}\n`);
    for (const target of targets) writeJson(path.join(directory, `${target}.json`), {
      schemaVersion: 1, target, scopes: ['project'],
      files: [{ from: 'payload.md', to: kind === 'skill' ? `skills/${slug}/SKILL.md` : `agents/${slug}.md` }]
    });
  }
  const directory = path.join(root, 'packs', 'review-flow');
  const manifest = {
    $schema: '../../schema/pack.schema.json', schemaVersion: 1, id: 'pack/review-flow', slug: 'review-flow',
    name: 'Review workflow', version: '1.0.0', summary: 'Collect and independently verify a bounded review.', outcomes: ['reviewed'],
    entry, workflow: [{ member: entry, phase: 'collect' }, { member: specialist, phase: 'verify', signal: 'Review material is available' }, { member: entry, phase: 'report' }],
    members: [
      { artifactId: entry, role: 'entrypoint', required: true },
      { artifactId: specialist, role: 'verifier', required: true, targets: { 'claude-code': specialist }, fallback: verifier }
    ],
    evidence: { reportSchema: '../../schema/pack-evidence.schema.json', ledgerLinkRequired: true, outcomeEvidence: [{ outcome: 'reviewed', memberArtifactIds: [entry, specialist] }] }
  };
  writeJson(path.join(directory, 'pack.json'), manifest);
  writeJson(path.join(directory, 'evaluations', 'behavioral.json'), {});
  const artifacts = loadArtifacts(root);
  const check = (value = manifest) => validatePack({ manifest: value, directory }, new Set(artifacts.map(({ manifest: item }) => item.id)), artifacts, root);
  return { root, cwd, directory, manifest, artifacts, check, entry, verifier, specialist };
}

test('skill entry and verifier support targets without subagents and publish optional workflow metadata', (context) => {
  const fixture = createWorkflowFixture(context);
  assert.deepEqual(fixture.check(), []);
  const analysis = analyzePackWorkflow(fixture.manifest, fixture.artifacts);
  assert.equal(analysis.eligible, true);
  assert.deepEqual(analysis.compatibility.map(({ target }) => target), ['claude-code', 'codex', 'cursor']);
  const published = publicPackCatalog([{ manifest: fixture.manifest }], fixture.artifacts).packs[0];
  assert.equal(published.entry, fixture.entry);
  assert.deepEqual(published.workflow, fixture.manifest.workflow);
  assert.deepEqual(published.members[1].targets, { 'claude-code': fixture.specialist });
  assert.equal(published.members[1].fallback, fixture.verifier);
  for (const { manifest } of loadPacks()) {
    assert.equal(Object.hasOwn(manifest, 'entry'), false);
    assert.equal(Object.hasOwn(manifest, 'workflow'), false);
  }
});

test('target overrides and fallback select the same members and flow in dry run and installation', (context) => {
  const fixture = createWorkflowFixture(context);
  for (const [target, expected] of [['claude-code', fixture.specialist], ['codex', fixture.verifier], ['cursor', fixture.verifier]]) {
    const options = { root: fixture.root, cwd: fixture.cwd, target };
    const plan = planPackInstall('review-flow', options);
    assert.equal(plan.members[1].member.artifactId, expected);
    assert.equal(plan.entry, fixture.entry);
    assert.deepEqual(plan.workflow.map(({ member }) => member), [fixture.entry, expected, fixture.entry]);
    const configRoot = plan.members[0].plan.configRoot;
    assert.equal(existsSync(configRoot), false, 'planning writes nothing');
    const installed = installPack('review-flow', options);
    assert.deepEqual(installed.installed.map(({ artifact }) => artifact.id), plan.members.map(({ member }) => member.artifactId));
    assert.deepEqual(installed.workflow, plan.workflow);
    assert.equal(installed.entry, plan.entry);
    for (const { plan: memberPlan } of plan.members) for (const write of memberPlan.writes) {
      const file = path.join(memberPlan.configRoot, write.path);
      assert.ok(existsSync(file), write.path);
      assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), write.sha256);
    }
    assert.deepEqual(doctor(options).findings, []);
    removePack('review-flow', options);
  }
});

test('workflow and entry references reject non-members before planning writes', (context) => {
  const fixture = createWorkflowFixture(context);
  fixture.manifest.workflow[0].member = fixture.verifier;
  assert.ok(fixture.check().some((error) => /workflow step must name a member/.test(error)));
  writeJson(path.join(fixture.directory, 'pack.json'), fixture.manifest);
  assert.throws(() => planPackInstall('review-flow', { root: fixture.root, cwd: fixture.cwd }), /workflow step must name a member/);
  fixture.manifest.entry = fixture.verifier;
  assert.ok(fixture.check().some((error) => /entry must name/.test(error)));
  assert.deepEqual(readdirSync(fixture.cwd), []);
});

// Apply the published field schemas directly, without adding a JSON Schema dependency.
function acceptsField(schema, value) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (Object.keys(value).length < (schema.minProperties || 0)) return false;
    if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, child]) => schema.properties[key]
      ? acceptsField(schema.properties[key], child) : schema.additionalProperties !== false);
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems || 0) && value.every((item) => acceptsField(schema.items, item));
  if (schema.type === 'string' && (typeof value !== 'string' || [...value].length < (schema.minLength || 0) || [...value].length > (schema.maxLength || Infinity))) return false;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  return !schema.enum || schema.enum.includes(value);
}

test('schema and hand validator agree on each optional pack field and nested workflow field', (context) => {
  const fixture = createWorkflowFixture(context);
  const schema = JSON.parse(readFileSync(path.join(ROOT, 'schema', 'pack.schema.json'), 'utf8'));
  const fields = [
    ['entry', schema.properties.entry, [fixture.entry], [null, 4, '', 'unknown']],
    ['workflow', schema.properties.workflow, [fixture.manifest.workflow, [{ member: fixture.entry, phase: 'verify', signal: '🦊'.repeat(240) }]], [null, [], {}, [null], [{ member: fixture.entry }], [{ member: fixture.entry, phase: 'Bad phase' }], [{ member: fixture.entry, phase: 'verify', signal: '' }], [{ member: fixture.entry, phase: 'verify', signal: 4 }], [{ member: fixture.entry, phase: 'verify', signal: 'x'.repeat(241) }], [{ member: fixture.entry, phase: 'verify', extra: true }]]],
    ['targets', schema.properties.members.items.properties.targets, [{ codex: fixture.verifier }], [null, {}, [], { unknown: fixture.verifier }, { codex: 4 }, { codex: 'unknown' }]],
    ['fallback', schema.properties.members.items.properties.fallback, [fixture.verifier], [null, 4, '', 'unknown']]
  ];
  for (const [field, rule, valid, invalid] of fields) {
    assert.ok(rule, field);
    const required = ['targets', 'fallback'].includes(field) ? schema.properties.members.items.required : schema.required;
    assert.equal(required.includes(field), false, `${field} is optional`);
    for (const [values, expected] of [[valid, true], [invalid, false]]) for (const value of values) {
      const manifest = structuredClone(fixture.manifest);
      if (['targets', 'fallback'].includes(field)) manifest.members[1][field] = value;
      else manifest[field] = value;
      assert.equal(acceptsField(rule, value), expected, `${field}: schema ${JSON.stringify(value)}`);
      assert.equal(fixture.check(manifest).length === 0, expected, `${field}: validator ${JSON.stringify(value)}`);
    }
  }
  const absent = structuredClone(fixture.manifest);
  delete absent.entry; delete absent.workflow; delete absent.members[1].targets; delete absent.members[1].fallback;
  assert.deepEqual(fixture.check(absent), []);
});


test('distinct procedure and verifier skills validate without any subagent member', (context) => {
  const fixture = createWorkflowFixture(context);
  const manifest = structuredClone(fixture.manifest);
  manifest.members[1] = { artifactId: fixture.verifier, role: 'verifier', required: true };
  manifest.evidence.outcomeEvidence[0].memberArtifactIds[1] = fixture.verifier;
  manifest.workflow[1].member = fixture.verifier;
  assert.deepEqual(fixture.check(manifest), []);
  assert.equal(analyzePackWorkflow(manifest, fixture.artifacts).criteria.independentRequiredAssurance, true);
});

test('target selection rejects unknown, wrong-role, and duplicate alternatives', (context) => {
  const fixture = createWorkflowFixture(context);
  const unknown = structuredClone(fixture.manifest);
  unknown.members[1].fallback = 'skill/development/testing/missing-review';
  assert.ok(fixture.check(unknown).some((error) => /unknown artifact/.test(error)));
  const wrongRole = structuredClone(fixture.manifest);
  wrongRole.members[0].fallback = fixture.specialist;
  assert.ok(fixture.check(wrongRole).some((error) => /incompatible with role/.test(error)));
  const duplicate = structuredClone(fixture.manifest);
  duplicate.members[1].fallback = fixture.entry;
  assert.ok(fixture.check(duplicate).some((error) => /duplicate artifacts/.test(error)));
});

test('explicit target members never fall back after an unsupported adapter', (context) => {
  const fixture = createWorkflowFixture(context);
  fixture.manifest.members[1].targets.codex = fixture.specialist;
  writeJson(path.join(fixture.directory, 'pack.json'), fixture.manifest);
  assert.throws(() => planPackInstall('review-flow', { root: fixture.root, cwd: fixture.cwd, target: 'codex' }), /required member.*cannot install for codex/);
  assert.deepEqual(readdirSync(fixture.cwd), []);
});
