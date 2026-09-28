import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { doctor, installArtifact, planArtifactInstall, removeArtifact } from '../scripts/lib/install.mjs';
import { loadArtifacts } from '../scripts/lib/catalog.mjs';
import { cleanGitEnvironment } from './git-env.mjs';
import { fileURLToPath } from 'node:url';

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// commit-guard is the hook fixture of the settings, marker, and notice tests; they install it without
// its shell-command-guard prerequisite (`prerequisites: false`) so each checks one hook's entries.

test('skill install and uninstall round-trip', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-skill-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const installed = installArtifact('debug-systematically', { cwd: directory });
  const skill = path.join(directory, '.claude', 'skills', 'debug-systematically', 'SKILL.md');
  assert.ok(existsSync(skill));
  assert.match(readFileSync(skill, 'utf8'), /# Debug systematically/);
  assert.equal(doctor({ cwd: directory }).findings.length, 0);

  removeArtifact('debug-systematically', { cwd: directory });
  assert.equal(existsSync(skill), false);
  assert.equal(installed.artifact.slug, 'debug-systematically');
});

test('hook install merges and uninstall preserves unrelated settings', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-hook-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const claude = path.join(directory, '.claude');
  mkdirSync(claude, { recursive: true });
  writeFileSync(path.join(claude, 'settings.json'), `${JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2)}\n`);

  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  let settings = JSON.parse(readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['Read']);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /\$\{CLAUDE_PROJECT_DIR\}/);
  assert.ok(existsSync(path.join(claude, 'hooks', 'youdede', 'commit-guard.mjs')));

  removeArtifact('commit-guard', { cwd: directory });
  settings = JSON.parse(readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.deepEqual(settings, { permissions: { allow: ['Read'] } });
});

test('all hooks compose in one project and uninstall without collisions', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede all hooks '));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const claude = path.join(directory, '.claude');
  const settingsFile = path.join(claude, 'settings.json');
  const original = {
    permissions: { allow: ['Read'] },
    env: { USER_SETTING: 'preserved' },
    hooks: {
      PreToolUse: [{
        matcher: 'WebFetch',
        description: '[user:existing-hook] preserved entry',
        hooks: [{ type: 'command', command: 'true', timeout: 5 }]
      }]
    }
  };
  mkdirSync(claude, { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(original, null, 2)}\n`);

  const hooks = loadArtifacts().filter(({ manifest }) => manifest.kind === 'hook');
  const expectedByEvent = new Map();
  for (const record of hooks) {
    installArtifact(record.manifest.slug, { cwd: directory });
    for (const [event, entries] of Object.entries(record.adapters['claude-code'].data.settingsPatch.hooks)) {
      expectedByEvent.set(event, (expectedByEvent.get(event) ?? 0) + entries.length);
    }
    const installedScript = path.join(claude, 'hooks', 'youdede', `${record.manifest.slug}.mjs`);
    assert.ok(existsSync(installedScript), record.manifest.id);
    if (process.platform !== 'win32') assert.equal(statSync(installedScript).mode & 0o111, 0o111, record.manifest.id);
  }

  const installedSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  for (const [event, count] of expectedByEvent) {
    const userEntries = original.hooks[event]?.length ?? 0;
    assert.equal(installedSettings.hooks[event].length, count + userEntries, event);
  }
  const markers = Object.values(installedSettings.hooks)
    .flat()
    .map((entry) => entry.description)
    .filter((description) => description.startsWith('[youdede:'));
  const expectedMarkers = hooks.reduce((count, record) => count + Object.values(record.adapters['claude-code'].data.settingsPatch.hooks)
    .reduce((eventCount, entries) => eventCount + entries.length, 0), 0);
  assert.equal(markers.length, expectedMarkers);
  assert.equal(new Set(markers).size, markers.length);
  assert.deepEqual(doctor({ cwd: directory }), {
    configRoot: claude,
    installs: hooks.length,
    findings: []
  });

  // A hook another installed hook needs as a prerequisite is removed after it.
  const dependents = hooks.filter((record) => record.manifest.relationships.prerequisites.length);
  for (const record of [...dependents, ...hooks.filter((record) => !dependents.includes(record)).toReversed()]) {
    removeArtifact(record.manifest.slug, { cwd: directory });
  }
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), original);
  assert.equal(doctor({ cwd: directory }).installs, 0);
});

test('subagent install and uninstall round-trip', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-agent-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  installArtifact('dependency-risk-reviewer', { cwd: directory });
  const agent = path.join(directory, '.claude', 'agents', 'dependency-risk-reviewer.md');
  assert.ok(existsSync(agent));
  assert.match(readFileSync(agent, 'utf8'), /tools: Read, Grep, Glob/);

  removeArtifact('dependency-risk-reviewer', { cwd: directory });
  assert.equal(existsSync(agent), false);
});

test('hybrid skill installs and runs its deterministic helper in one operation', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-hybrid-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  installArtifact('extract-youtube-captions', { cwd: directory });
  const helper = path.join(directory, '.claude', 'skills', 'extract-youtube-captions', 'scripts', 'normalize-json3.mjs');
  const input = path.join(directory, 'captions.json3');
  writeFileSync(input, JSON.stringify({ events: [{ segs: [{ utf8: 'one &amp; two' }] }] }));
  assert.ok(existsSync(helper));
  const result = spawnSync(process.execPath, [helper, input], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'one & two\n');
  removeArtifact('extract-youtube-captions', { cwd: directory });
  assert.equal(existsSync(helper), false);
});

test('Codex skill adapter installs metadata and deterministic helpers in one operation', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-codex-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  installArtifact('author-effective-agent-skill', { cwd: directory, target: 'codex' });
  const installed = path.join(directory, '.agents', 'skills', 'author-effective-agent-skill');
  assert.ok(existsSync(path.join(installed, 'SKILL.md')));
  assert.ok(existsSync(path.join(installed, 'agents', 'openai.yaml')));
  assert.ok(existsSync(path.join(installed, 'scripts', 'validate-skill.mjs')));
  assert.equal(doctor({ cwd: directory, target: 'codex' }).findings.length, 0);
  removeArtifact('author-effective-agent-skill', { cwd: directory, target: 'codex' });
  assert.equal(existsSync(installed), false);
});

test('new hybrid helpers run from installed absolute paths for both targets in a path with spaces', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede hybrid install '));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const sql = path.join(directory, 'migration.sql');
  const workflow = path.join(directory, 'workflow.yml');
  const releaseFile = path.join(directory, 'release.txt');
  const beforeSchema = path.join(directory, 'before.schema.json');
  const afterSchema = path.join(directory, 'after.schema.json');
  const packageManifest = path.join(directory, 'package.json');
  writeFileSync(sql, 'DROP TABLE archived_users;\n');
  writeFileSync(workflow, 'on: pull_request\npermissions:\n  contents: read\n');
  writeFileSync(beforeSchema, '{"type":"object","properties":{"id":{"type":"string"}}}\n');
  writeFileSync(afterSchema, '{"type":"object","required":["id"],"properties":{"id":{"type":"string"}}}\n');
  writeFileSync(packageManifest, '{"scripts":{"postinstall":"node setup.mjs"}}\n');
  runGit(directory, ['init']);
  runGit(directory, ['config', 'user.email', 'test@example.invalid']);
  runGit(directory, ['config', 'user.name', 'Test']);
  writeFileSync(releaseFile, 'before\n');
  runGit(directory, ['add', 'release.txt']);
  runGit(directory, ['commit', '-m', 'first']);
  const from = runGit(directory, ['rev-parse', 'HEAD']);
  writeFileSync(releaseFile, 'after\n');
  runGit(directory, ['commit', '-am', 'second']);

  for (const target of ['claude-code', 'codex']) {
    const config = target === 'codex' ? '.agents' : '.claude';
    for (const slug of ['review-database-migration-plan', 'review-ci-workflow-change', 'write-release-notes-from-evidence', 'review-schema-evolution', 'review-supply-chain-change']) {
      installArtifact(slug, { cwd: directory, target });
    }
    const skillRoot = path.join(directory, config, 'skills');
    const sqlResult = spawnSync(process.execPath, [
      path.join(skillRoot, 'review-database-migration-plan', 'scripts', 'classify-sql-risks.mjs'), '--file', sql
    ], { encoding: 'utf8' });
    assert.equal(sqlResult.status, 0, sqlResult.stderr);
    assert.match(sqlResult.stdout, /MIG_SQL_DROP_TABLE/);

    const workflowResult = spawnSync(process.execPath, [
      path.join(skillRoot, 'review-ci-workflow-change', 'scripts', 'collect-workflow-signals.mjs'), '--file', workflow
    ], { encoding: 'utf8' });
    assert.equal(workflowResult.status, 0, workflowResult.stderr);
    assert.match(workflowResult.stdout, /event-declaration/);

    const releaseResult = spawnSync(process.execPath, [
      path.join(skillRoot, 'write-release-notes-from-evidence', 'scripts', 'collect-release-evidence.mjs'),
      '--cwd', directory, '--from', from, '--to', 'HEAD'
    ], { encoding: 'utf8' });
    assert.equal(releaseResult.status, 0, releaseResult.stderr);
    assert.match(releaseResult.stdout, /release\.txt/);

    const schemaResult = spawnSync(process.execPath, [
      path.join(skillRoot, 'review-schema-evolution', 'scripts', 'compare-json-schema.mjs'),
      '--before', beforeSchema, '--after', afterSchema
    ], { encoding: 'utf8' });
    assert.equal(schemaResult.status, 0, schemaResult.stderr);
    assert.match(schemaResult.stdout, /REQUIRED_ADDED/);

    const supplyResult = spawnSync(process.execPath, [
      path.join(skillRoot, 'review-supply-chain-change', 'scripts', 'collect-supply-chain-signals.mjs'),
      '--root', directory, '--file', 'package.json'
    ], { encoding: 'utf8' });
    assert.equal(supplyResult.status, 0, supplyResult.stderr);
    assert.match(supplyResult.stdout, /postinstall/);

    for (const slug of ['review-database-migration-plan', 'review-ci-workflow-change', 'write-release-notes-from-evidence', 'review-schema-evolution', 'review-supply-chain-change']) {
      removeArtifact(slug, { cwd: directory, target });
    }
  }
});

test('every Codex-supported skill installs and removes independently', () => {
  for (const { manifest } of loadArtifacts().filter(({ manifest, adapters }) => manifest.kind === 'skill' && adapters.codex)) {
    const directory = mkdtempSync(path.join(os.tmpdir(), `youdede-codex-${manifest.slug}-`));
    try {
      const installed = installArtifact(manifest.slug, { cwd: directory, target: 'codex' });
      assert.ok(installed.files.some((file) => file.endsWith(path.join('agents', 'openai.yaml'))), manifest.id);
      assert.deepEqual(doctor({ cwd: directory, target: 'codex' }), {
        configRoot: path.join(directory, '.agents'),
        installs: 1,
        findings: []
      });
      removeArtifact(manifest.slug, { cwd: directory, target: 'codex' });
      assert.equal(doctor({ cwd: directory, target: 'codex' }).installs, 0, manifest.id);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('malformed settings abort hook installation before copying payloads', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-invalid-settings-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const claude = path.join(directory, '.claude');
  mkdirSync(claude, { recursive: true });
  writeFileSync(path.join(claude, 'settings.json'), '{ invalid json');

  assert.throws(() => installArtifact('commit-guard', { cwd: directory, prerequisites: false }), /invalid JSON/);
  assert.equal(existsSync(path.join(claude, 'hooks', 'youdede', 'commit-guard.mjs')), false);
  assert.equal(readFileSync(path.join(claude, 'settings.json'), 'utf8'), '{ invalid json');
});

test('installer refuses unmanaged collisions and reversibly restores forced replacements', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-safe-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const skillDirectory = path.join(directory, '.claude', 'skills', 'debug-systematically');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(path.join(skillDirectory, 'SKILL.md'), 'unmanaged\n');
  assert.throws(() => installArtifact('debug-systematically', { cwd: directory }), /unmanaged/);

  installArtifact('debug-systematically', { cwd: directory, force: true });
  writeFileSync(path.join(skillDirectory, 'SKILL.md'), 'user edit\n');
  assert.throws(() => removeArtifact('debug-systematically', { cwd: directory }), /changed since installation/);
  removeArtifact('debug-systematically', { cwd: directory, force: true });
  assert.equal(readFileSync(path.join(skillDirectory, 'SKILL.md'), 'utf8'), 'unmanaged\n');
});

test('forced replacement refuses an unbounded unmanaged backup', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-large-displaced-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const skillDirectory = path.join(directory, '.claude', 'skills', 'debug-systematically');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(path.join(skillDirectory, 'SKILL.md'), Buffer.alloc(1024 * 1024 + 1));

  assert.throws(
    () => installArtifact('debug-systematically', { cwd: directory, force: true }),
    /reversible replacement limit/
  );
});

test('uninstall removes a toolkit-created settings file even when its creator is removed first', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-settings-origin-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsFile = path.join(directory, '.claude', 'settings.json');

  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  installArtifact('shell-command-guard', { cwd: directory });
  removeArtifact('commit-guard', { cwd: directory });
  assert.ok(existsSync(settingsFile));
  removeArtifact('shell-command-guard', { cwd: directory });
  assert.equal(existsSync(settingsFile), false);
});

test('forced hook-marker replacement restores the displaced unmanaged entry', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-hook-displaced-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const claude = path.join(directory, '.claude');
  const settingsFile = path.join(claude, 'settings.json');
  const displaced = {
    matcher: 'Bash',
    description: '[youdede:commit-guard] user-owned predecessor',
    hooks: [{ type: 'command', command: 'user-owned-command', timeout: 3 }]
  };
  mkdirSync(claude, { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify({ hooks: { PreToolUse: [displaced] } }, null, 2)}\n`);

  installArtifact('commit-guard', { cwd: directory, prerequisites: false, force: true });
  assert.doesNotMatch(readFileSync(settingsFile, 'utf8'), /user-owned-command/);
  removeArtifact('commit-guard', { cwd: directory });
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')).hooks.PreToolUse, [displaced]);
});

test('installation state containing reversible backups is owner-only', { skip: process.platform === 'win32' }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-state-mode-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  installArtifact('debug-systematically', { cwd: directory });
  const state = path.join(directory, '.claude', '.youdede-toolkit', 'state.json');
  assert.equal(statSync(state).mode & 0o777, 0o600);
});

test('reinstall refuses modified managed files unless force is explicit', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-reinstall-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  installArtifact('debug-systematically', { cwd: directory });
  const installed = path.join(directory, '.claude', 'skills', 'debug-systematically', 'SKILL.md');
  writeFileSync(installed, 'user customization\n');

  assert.throws(() => installArtifact('debug-systematically', { cwd: directory }), /changed since installation/);
  assert.equal(readFileSync(installed, 'utf8'), 'user customization\n');
  installArtifact('debug-systematically', { cwd: directory, force: true });
  assert.match(readFileSync(installed, 'utf8'), /# Debug systematically/);
});

test('hook settings merge preserves a restrictive existing file mode', { skip: process.platform === 'win32' }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-mode-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const claude = path.join(directory, '.claude');
  const settings = path.join(claude, 'settings.json');
  mkdirSync(claude, { recursive: true });
  writeFileSync(settings, '{}\n');
  chmodSync(settings, 0o600);

  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  assert.equal(statSync(settings).mode & 0o777, 0o600);
  chmodSync(settings, 0o640);
  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  assert.equal(statSync(settings).mode & 0o777, 0o640);
});

test('reinstall refuses a user-modified managed hook entry unless force is explicit', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-hook-edit-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  const settingsFile = path.join(directory, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.hooks.PreToolUse[0].hooks[0].command = 'user-custom-command';
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

  assert.deepEqual(doctor({ cwd: directory }).findings, [{
    key: 'claude-code:project:hook/security/secrets/commit-guard',
    path: 'settings.json#hooks.PreToolUse',
    status: 'hook-settings-modified'
  }]);

  assert.throws(() => installArtifact('commit-guard', { cwd: directory, prerequisites: false }), /modified or unmanaged/);
  assert.match(readFileSync(settingsFile, 'utf8'), /user-custom-command/);
  installArtifact('commit-guard', { cwd: directory, prerequisites: false, force: true });
  assert.doesNotMatch(readFileSync(settingsFile, 'utf8'), /user-custom-command/);
  assert.equal(doctor({ cwd: directory }).findings.length, 0);
});

test('hook uninstall refuses settings drift and force removes only its stable marker', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-remove-hook-edit-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  const settingsFile = path.join(directory, '.claude', 'settings.json');
  const scriptFile = path.join(directory, '.claude', 'hooks', 'youdede', 'commit-guard.mjs');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.hooks.PreToolUse[0].hooks[0].timeout += 1;
  settings.hooks.PreToolUse.push({
    matcher: 'Read',
    description: '[user:unrelated] keep this entry',
    hooks: [{ type: 'command', command: 'true', timeout: 1 }]
  });
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

  assert.throws(() => removeArtifact('commit-guard', { cwd: directory }), /changed since installation/);
  assert.equal(existsSync(scriptFile), true);
  assert.equal(doctor({ cwd: directory }).installs, 1);

  removeArtifact('commit-guard', { cwd: directory, force: true });
  const after = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(after.hooks.PreToolUse, [settings.hooks.PreToolUse[1]]);
  assert.equal(existsSync(scriptFile), false);
  assert.equal(doctor({ cwd: directory }).installs, 0);
});

test('uninstall refuses an unmarked hook state record instead of deleting unmanaged entries', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-remove-hook-unmarked-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  const settingsFile = path.join(directory, '.claude', 'settings.json');
  const stateFile = path.join(directory, '.claude', '.youdede-toolkit', 'state.json');

  const userEntry = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'echo user-owned' }]
  };
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.hooks.PreToolUse.push(userEntry);
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

  // A hook record whose marker cannot be resolved must never drive a marker filter:
  // filtering on null would match every entry the user wrote themselves.
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const key = Object.keys(state.installs)[0];
  state.installs[key].hooks = state.installs[key].hooks.map(({ event }) => ({ event }));
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  assert.throws(() => removeArtifact('commit-guard', { cwd: directory, force: true }), /no \[youdede:<slug>\] marker/);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')).hooks.PreToolUse[1], userEntry);
  assert.equal(doctor({ cwd: directory }).findings.some((finding) => finding.status === 'hook-state-unmarked'), true);
});

test('uninstall honours a legacy hook state record that carries only a marker', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-remove-hook-legacy-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  const settingsFile = path.join(directory, '.claude', 'settings.json');
  const stateFile = path.join(directory, '.claude', '.youdede-toolkit', 'state.json');

  const userEntry = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'echo user-owned' }]
  };
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.hooks.PreToolUse.push(userEntry);
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const key = Object.keys(state.installs)[0];
  state.installs[key].hooks = state.installs[key].hooks.map(({ event, marker }) => ({ event, marker }));
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  removeArtifact('commit-guard', { cwd: directory, force: true });
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')).hooks.PreToolUse, [userEntry]);
  assert.equal(existsSync(path.join(directory, '.claude', 'hooks', 'youdede', 'commit-guard.mjs')), false);
});

test('concurrent installs into one config root record every artifact', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-parallel-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../bin/youdede-toolkit.mjs', import.meta.url));
  const slugs = ['debug-systematically', 'write-session-handoff', 'resolve-next-decision', 'make-practical-decision'];

  const running = slugs.map((slug) => spawnSync(process.execPath, [cli, 'add', slug, '--target', 'claude-code', '--scope', 'project'], {
    cwd: directory,
    encoding: 'utf8'
  }));
  for (const result of running) assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(readFileSync(path.join(directory, '.claude', '.youdede-toolkit', 'state.json'), 'utf8'));
  assert.equal(Object.keys(state.installs).length, slugs.length);
  assert.equal(existsSync(path.join(directory, '.claude', '.youdede-toolkit', 'state.lock')), false);
  assert.equal(doctor({ cwd: directory }).findings.length, 0);
});

test('a symlinked state directory is refused before the lock touches anything outside the root (PR38-CODEX8-2)', { skip: process.platform === 'win32' }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-lock-link-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-lock-outside-'));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(path.join(directory, '.claude'));
  symlinkSync(outside, path.join(directory, '.claude', '.youdede-toolkit'));
  const external = path.join(outside, 'state.lock');
  writeFileSync(external, 'EXTERNAL-LOCK-MUST-SURVIVE\n');
  const old = new Date(Date.now() - 180_000);
  utimesSync(external, old, old);
  const cli = fileURLToPath(new URL('../bin/youdede-toolkit.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'add', 'commit-guard', '--target', 'claude-code', '--scope', 'project'], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /traverses symbolic link '\.youdede-toolkit'/);
  assert.equal(readFileSync(external, 'utf8'), 'EXTERNAL-LOCK-MUST-SURVIVE\n');
  assert.deepEqual(readdirSync(outside), ['state.lock']);
});

test('a lock that is a dangling symbolic link is refused at once (PR38-CODEX8-3)', { skip: process.platform === 'win32' }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-lock-dangling-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateDirectory = path.join(directory, '.claude', '.youdede-toolkit');
  mkdirSync(stateDirectory, { recursive: true });
  const lock = path.join(stateDirectory, 'state.lock');
  symlinkSync(path.join(directory, 'missing-target'), lock);
  const cli = fileURLToPath(new URL('../bin/youdede-toolkit.mjs', import.meta.url));
  const started = Date.now();
  const result = spawnSync(process.execPath, [cli, 'add', 'commit-guard', '--target', 'claude-code', '--scope', 'project'], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is a symbolic link; refusing to use it as the installation lock/);
  assert.equal(lstatSync(lock).isSymbolicLink(), true);
});

test('a failed multi-file install rolls back every file it had already written', { skip: process.platform === 'win32' }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-rollback-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const skillRoot = path.join(directory, '.claude', 'skills', 'debug-systematically');
  const references = path.join(skillRoot, 'references');

  // debug-systematically ships SKILL.md plus reference files. Making only the nested directory
  // unwritable lets the first payload file land and the next one fail, which is the exact
  // partial-write the rollback block exists for.
  mkdirSync(references, { recursive: true });
  chmodSync(references, 0o500);

  assert.throws(() => installArtifact('debug-systematically', { cwd: directory }), /EACCES|EPERM/);
  chmodSync(references, 0o700);

  assert.equal(existsSync(path.join(skillRoot, 'SKILL.md')), false, 'partially written payload must be removed');
  assert.equal(existsSync(path.join(directory, '.claude', '.youdede-toolkit', 'state.json')), false, 'no install may be recorded');
  assert.equal(doctor({ cwd: directory }).installs, 0);
});

test('installing carries the licence notice with the copied files and uninstalling withdraws it', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-notice-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const notice = path.join(directory, '.claude', '.youdede-toolkit', 'NOTICE.md');

  installArtifact('debug-systematically', { cwd: directory });
  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  let text = readFileSync(notice, 'utf8');
  assert.match(text, /skill\/development\/debugging\/debug-systematically/);
  assert.match(text, /hook\/security\/secrets\/commit-guard/);
  assert.match(text, /MIT License/);
  assert.match(text, /Copyright \(c\) 2026 Youdede/);

  removeArtifact('commit-guard', { cwd: directory });
  text = readFileSync(notice, 'utf8');
  assert.doesNotMatch(text, /commit-guard/);
  assert.match(text, /debug-systematically/);

  // The notice exists to accompany installed files; with none left it must not linger.
  removeArtifact('debug-systematically', { cwd: directory });
  assert.equal(existsSync(notice), false);
});

test('doctor reports missing and duplicate managed hook settings', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-doctor-hook-settings-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  const settingsFile = path.join(directory, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  const entry = structuredClone(settings.hooks.PreToolUse[0]);

  settings.hooks.PreToolUse = [];
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  assert.equal(doctor({ cwd: directory }).findings.at(-1).status, 'hook-settings-missing');

  settings.hooks.PreToolUse = [entry, structuredClone(entry)];
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  assert.equal(doctor({ cwd: directory }).findings.at(-1).status, 'hook-settings-duplicate');
});

test('dry-run returns hashes and mutations without touching the target', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-plan-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const result = planArtifactInstall('debug-systematically', { cwd: directory });
  assert.equal(result.artifact.slug, 'debug-systematically');
  assert.ok(result.writes.some((entry) => entry.path.endsWith('SKILL.md')));
  assert.ok(result.writes.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.deepEqual(result.state, { path: path.join('.youdede-toolkit', 'state.json'), action: 'update' });
  assert.equal(existsSync(path.join(directory, '.claude')), false);
});

test('installer refuses destinations that traverse a symbolic link', { skip: process.platform === 'win32' }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-symlink-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-outside-'));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const claude = path.join(directory, '.claude');
  mkdirSync(claude, { recursive: true });
  symlinkSync(outside, path.join(claude, 'skills'));

  assert.throws(() => planArtifactInstall('debug-systematically', { cwd: directory }), /symbolic link/);
  assert.equal(existsSync(path.join(outside, 'debug-systematically')), false);
});

test('doctor reports an ancestor symbolic link without reading through it', { skip: process.platform === 'win32' }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-doctor-symlink-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'youdede-doctor-outside-'));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const claude = path.join(directory, '.claude');
  mkdirSync(path.join(claude, '.youdede-toolkit'), { recursive: true });
  writeFileSync(path.join(outside, 'SKILL.md'), 'outside\n');
  symlinkSync(outside, path.join(claude, 'skills'));
  const key = 'claude-code:project:skill/development/debugging/debug-systematically';
  writeFileSync(path.join(claude, '.youdede-toolkit', 'state.json'), `${JSON.stringify({
    schemaVersion: 1,
    installs: {
      [key]: {
        files: [{ path: path.join('skills', 'SKILL.md'), sha256: '0'.repeat(64) }]
      }
    }
  }, null, 2)}\n`);

  assert.deepEqual(doctor({ cwd: directory }).findings, [{
    key,
    path: path.join('skills', 'SKILL.md'),
    status: 'symbolic-link'
  }]);
});

test('every catalog artifact installs and removes independently', () => {
  for (const { manifest } of loadArtifacts()) {
    const directory = mkdtempSync(path.join(os.tmpdir(), `youdede-all-${manifest.slug}-`));
    try {
      const installed = installArtifact(manifest.slug, { cwd: directory });
      assert.ok(installed.files.length > 0, manifest.id);
      // Every artifact brings its prerequisites (required links), whatever their kind.
      const prerequisites = manifest.relationships.prerequisites;
      assert.deepEqual(installed.prerequisites.map((prerequisite) => prerequisite.id), prerequisites, manifest.id);
      assert.deepEqual(doctor({ cwd: directory }), {
        configRoot: installed.configRoot,
        installs: 1 + prerequisites.length,
        findings: []
      });
      removeArtifact(manifest.slug, { cwd: directory });
      for (const id of prerequisites) removeArtifact(id, { cwd: directory });
      assert.equal(doctor({ cwd: directory }).installs, 0, manifest.id);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('installed artifact remains removable after it leaves the current catalog', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-remove-retired-artifact-'));
  const emptyRepository = mkdtempSync(path.join(os.tmpdir(), 'youdede-empty-catalog-'));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(emptyRepository, { recursive: true, force: true });
  });

  installArtifact('debug-systematically', { cwd: directory });
  const installed = path.join(directory, '.claude', 'skills', 'debug-systematically', 'SKILL.md');
  assert.equal(existsSync(installed), true);

  const result = removeArtifact('debug-systematically', { cwd: directory, root: emptyRepository });
  assert.equal(result.artifact.kind, 'skill');
  assert.equal(existsSync(installed), false);
  assert.equal(doctor({ cwd: directory }).installs, 0);
});

test('removing the last artifact leaves no installer state behind', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-install-cleanup-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  removeArtifact('commit-guard', { cwd: directory });
  assert.equal(existsSync(path.join(directory, '.claude', '.youdede-toolkit')), false);
  installArtifact('commit-guard', { cwd: directory, prerequisites: false });
  assert.equal(doctor({ cwd: directory }).findings.length, 0);
});

// Prerequisites (hook-design 1.7): an operation guard brings shell-command-guard, which owns the
// programs a command runs but does not contain.
test('adding an operation guard installs its prerequisite, and removing the prerequisite is refused', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-prerequisite-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const hooks = path.join(directory, '.claude', 'hooks', 'youdede');
  const cli = (...args) => spawnSync(process.execPath, [path.resolve('bin/youdede-toolkit.mjs'), ...args, '--cwd', directory], { encoding: 'utf8' });

  const plan = planArtifactInstall('package-publish-guard', { cwd: directory });
  assert.deepEqual(plan.prerequisites, ['hook/security/application-security/shell-command-guard']);
  const added = cli('add', 'package-publish-guard');
  assert.equal(added.status, 0, added.stderr);
  // Without a terminal the CLI installs the prerequisite and says why (tests/prerequisite-consent.test.mjs).
  assert.match(added.stdout, /^package-publish-guard cannot see hidden commands \(e\.g\. bash -c "\$X"\): shell-command-guard stops them\.\nInstalling it too; pass --no-prerequisites to skip\.\nInstalled prerequisite shell-command-guard\.\nInstalled hook\/operations\/package-publication\/package-publish-guard/);
  assert.ok(existsSync(path.join(hooks, 'shell-command-guard.mjs')));
  assert.deepEqual(planArtifactInstall('cloud-resource-deletion-guard', { cwd: directory }).prerequisites, []);

  const refused = cli('remove', 'shell-command-guard');
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, 'shell-command-guard is needed by package-publish-guard. Remove package-publish-guard first, or use --force.\n');
  assert.ok(existsSync(path.join(hooks, 'shell-command-guard.mjs')));
  removeArtifact('package-publish-guard', { cwd: directory });
  removeArtifact('shell-command-guard', { cwd: directory });
  assert.equal(doctor({ cwd: directory }).findings.length, 0);

  installArtifact('package-publish-guard', { cwd: directory });
  removeArtifact('shell-command-guard', { cwd: directory, force: true });
  assert.equal(existsSync(path.join(hooks, 'shell-command-guard.mjs')), false);
  removeArtifact('package-publish-guard', { cwd: directory });
});

test('a failed operation guard install removes the prerequisite it installed', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-prerequisite-rollback-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const hooks = path.join(directory, '.claude', 'hooks', 'youdede');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(path.join(hooks, 'package-publish-guard.mjs'), '// not managed by the toolkit\n');

  assert.throws(() => installArtifact('package-publish-guard', { cwd: directory }), /already exists and is unmanaged/);
  assert.equal(existsSync(path.join(hooks, 'shell-command-guard.mjs')), false);
  const state = path.join(directory, '.claude', '.youdede-toolkit', 'state.json');
  const installs = existsSync(state) ? Object.values(JSON.parse(readFileSync(state, 'utf8')).installs) : [];
  assert.deepEqual(installs.map((install) => install.artifactId), []);
});
