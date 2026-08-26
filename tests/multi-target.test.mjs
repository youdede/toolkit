import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadArtifacts } from '../scripts/lib/catalog.mjs';
import { doctor, installArtifact, removeArtifact } from '../scripts/lib/install.mjs';
import { resolveConfigRoot, resolveConfigRoots, SUPPORTED_TARGETS } from '../scripts/lib/targets.mjs';

const MATRIX = {
  skill: { 'claude-code': 166, codex: 166, 'gemini-cli': 166, 'github-copilot': 166, cursor: 166, opencode: 166 },
  hook: { 'claude-code': 57, codex: 22, 'gemini-cli': 22, 'github-copilot': 0, cursor: 22, opencode: 22 },
  subagent: { 'claude-code': 62, codex: 0, 'gemini-cli': 62, 'github-copilot': 62, cursor: 0, opencode: 50 }
};

function temporary(context, prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('runtime target matrix is explicit and never implies unsupported coverage', () => {
  assert.deepEqual(SUPPORTED_TARGETS, ['claude-code', 'codex', 'gemini-cli', 'github-copilot', 'cursor', 'opencode']);
  const artifacts = loadArtifacts();
  for (const [kind, expected] of Object.entries(MATRIX)) {
    const records = artifacts.filter(({ manifest }) => manifest.kind === kind);
    for (const [target, count] of Object.entries(expected)) {
      assert.equal(records.filter(({ adapters }) => adapters[target]).length, count, `${kind}/${target}`);
    }
  }
});

test('every generated adapter stays inside the documented native payload contract', () => {
  for (const record of loadArtifacts()) {
    for (const [target, adapterRecord] of Object.entries(record.adapters)) {
      if (!['gemini-cli', 'github-copilot', 'cursor', 'opencode'].includes(target)) continue;
      const adapter = adapterRecord.data;
      assert.ok(['stable', 'preview'].includes(adapter.stability), `${record.manifest.id}/${target}`);
      assert.ok(Array.isArray(adapter.limitations), `${record.manifest.id}/${target}`);
      if (record.manifest.kind === 'skill') {
        assert.ok(adapter.files.every(({ to }) => to === 'skills/{slug}' || to.startsWith('skills/{slug}/')));
        assert.ok(adapter.files.every(({ from }) => from !== 'agents' && !from.startsWith('agents/')));
      }
      if (record.manifest.kind !== 'subagent') continue;
      const mapping = adapter.files[0];
      const raw = readFileSync(path.resolve(record.directory, mapping.from), 'utf8');
      if (target === 'gemini-cli') {
        assert.match(raw, new RegExp(`^---\\nname: ${record.manifest.slug}\\n`));
        assert.match(raw, /\nkind: local\n/);
        assert.match(raw, /\nmax_turns: \d+\n/);
        assert.doesNotMatch(raw, /\n(?:maxTurns|effort):/);
      } else if (target === 'github-copilot') {
        assert.ok(mapping.to.endsWith('.agent.md'));
        assert.match(raw, /\ntools: \["read"(?:,"search")?\]\n/);
        assert.doesNotMatch(raw, /\n(?:model|maxTurns|effort):/);
      } else if (target === 'opencode') {
        assert.match(raw, /\nmode: subagent\nsteps: \d+\npermission:\n  "\*": deny\n/);
        assert.doesNotMatch(raw, /\n(?:model|maxTurns|effort):/);
      } else {
        assert.fail(`Cursor subagent adapter unexpectedly published for ${record.manifest.id}`);
      }
    }
  }
});

test('representative portable skill payloads install and remove from every new native root', (context) => {
  const representatives = new Set(['conduct-source-backed-research', 'debug-systematically', 'author-effective-agent-skill']);
  const artifacts = loadArtifacts().filter(({ manifest }) => manifest.kind === 'skill' && representatives.has(manifest.slug));
  const roots = { 'gemini-cli': '.gemini', 'github-copilot': '.github', cursor: '.cursor', opencode: '.opencode' };
  for (const [target, rootName] of Object.entries(roots)) {
    const directory = temporary(context, `youdede-${target}-skills-`);
    for (const { manifest } of artifacts) installArtifact(manifest.slug, { cwd: directory, target });
    assert.equal(doctor({ cwd: directory, target }).installs, artifacts.length);
    assert.deepEqual(doctor({ cwd: directory, target }).findings, []);
    assert.ok(existsSync(path.join(directory, rootName, 'skills', 'debug-systematically', 'SKILL.md')));
    assert.equal(existsSync(path.join(directory, rootName, 'skills', 'debug-systematically', 'agents', 'openai.yaml')), false);
    for (const { manifest } of artifacts.toReversed()) removeArtifact(manifest.slug, { cwd: directory, target });
    assert.equal(doctor({ cwd: directory, target }).installs, 0);
  }
});

test('native subagent profiles preserve target-specific authority and budgets', (context) => {
  const artifacts = loadArtifacts().filter(({ manifest }) => manifest.kind === 'subagent');
  const roots = { 'gemini-cli': '.gemini', 'github-copilot': '.github', opencode: '.opencode' };
  for (const [target, rootName] of Object.entries(roots)) {
    const supported = artifacts.filter(({ manifest, adapters }) => adapters[target]
      && ['dependency-risk-reviewer', 'source-credibility-auditor'].includes(manifest.slug));
    const directory = temporary(context, `youdede-${target}-agents-`);
    for (const { manifest } of supported) installArtifact(manifest.slug, { cwd: directory, target });
    assert.equal(doctor({ cwd: directory, target }).installs, supported.length);
    assert.deepEqual(doctor({ cwd: directory, target }).findings, []);
    const suffix = target === 'github-copilot' ? '.agent.md' : '.md';
    const profile = readFileSync(path.join(directory, rootName, 'agents', `dependency-risk-reviewer${suffix}`), 'utf8');
    if (target === 'gemini-cli') {
      assert.match(profile, /tools:\n  - read_file\n  - grep_search\n  - glob/);
      assert.match(profile, /max_turns: 12/);
      assert.doesNotMatch(profile, /maxTurns:|effort:/);
    } else if (target === 'github-copilot') {
      assert.match(profile, /tools: \["read","search"\]/);
      assert.match(profile, /within 12 turns/);
      assert.doesNotMatch(profile, /model: inherit|maxTurns:|effort:/);
    } else {
      assert.match(profile, /steps: 12/);
      assert.match(profile, /permission:\n  "\*": deny\n  read: allow\n  grep: allow\n  glob: allow/);
    }
    for (const { manifest } of supported.toReversed()) removeArtifact(manifest.slug, { cwd: directory, target });
    assert.equal(doctor({ cwd: directory, target }).installs, 0);
  }
});

test('unsupported authority and hook contracts fail before writing', (context) => {
  const directory = temporary(context, 'youdede-unsupported-targets-');
  assert.throws(() => installArtifact('dependency-risk-reviewer', { cwd: directory, target: 'cursor' }), /does not support cursor/);
  assert.throws(() => installArtifact('dependency-risk-reviewer', { cwd: directory, target: 'codex' }), /does not support codex/);
  assert.throws(() => installArtifact('rag-evaluation-reviewer', { cwd: directory, target: 'opencode' }), /does not support opencode/);
  assert.throws(() => installArtifact('shell-command-guard', { cwd: directory, target: 'github-copilot' }), /does not support github-copilot/);
  assert.throws(() => installArtifact('schema-compatibility-guard', { cwd: directory, target: 'cursor' }), /does not support cursor/);
  assert.equal(existsSync(path.join(directory, '.cursor')), false);
});

test('Codex, Gemini, and Cursor shell guards allow safe calls and block destructive calls', (context) => {
  const cases = [
    { target: 'codex', root: '.codex', tool: 'Bash', event: 'PreToolUse' },
    { target: 'gemini-cli', root: '.gemini', tool: 'run_shell_command', event: 'BeforeTool' },
    { target: 'cursor', root: '.cursor', tool: 'Shell', event: 'preToolUse' }
  ];
  for (const item of cases) {
    const directory = temporary(context, `youdede-${item.target}-hook-`);
    installArtifact('shell-command-guard', { cwd: directory, target: item.target });
    const script = path.join(directory, item.root, 'hooks', 'youdede', 'shell-command-guard.mjs');
    const run = (command) => spawnSync(process.execPath, [script, '--target', item.target, '--failure-policy', 'fail-closed'], {
      input: `${JSON.stringify({ hook_event_name: item.event, tool_name: item.tool, tool_input: { command }, cwd: directory })}\n`,
      encoding: 'utf8'
    });
    const allowed = run('pwd');
    assert.equal(allowed.status, 0, allowed.stderr);
    if (item.target === 'codex') assert.equal(allowed.stdout, '');
    else assert.deepEqual(JSON.parse(allowed.stdout), {});
    const blocked = run('rm -rf /');
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /BLOCKED by shell-command-guard/);
    assert.deepEqual(doctor({ cwd: directory, target: item.target }).findings, []);
    removeArtifact('shell-command-guard', { cwd: directory, target: item.target });
    assert.equal(doctor({ cwd: directory, target: item.target }).installs, 0);
  }
});

test('Codex, Gemini, and Cursor settings use native schemas and stable ownership markers', (context) => {
  const directory = temporary(context, 'youdede-native-hook-settings-');
  installArtifact('commit-guard', { cwd: directory, target: 'codex' });
  const codex = JSON.parse(readFileSync(path.join(directory, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codex.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].timeout, 30);
  assert.match(codex.hooks.PreToolUse[0].hooks[0].statusMessage, /\[youdede:commit-guard\]/);
  assert.match(codex.hooks.PreToolUse[0].hooks[0].command, /\.codex\/hooks\/youdede\/commit-guard\.mjs/);
  removeArtifact('commit-guard', { cwd: directory, target: 'codex' });

  installArtifact('commit-guard', { cwd: directory, target: 'gemini-cli' });
  const gemini = JSON.parse(readFileSync(path.join(directory, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(gemini.hooks.BeforeTool[0].matcher, 'run_shell_command');
  assert.equal(gemini.hooks.BeforeTool[0].hooks[0].timeout, 30000);
  assert.match(gemini.hooks.BeforeTool[0].hooks[0].description, /\[youdede:commit-guard\]/);
  removeArtifact('commit-guard', { cwd: directory, target: 'gemini-cli' });

  installArtifact('commit-guard', { cwd: directory, target: 'cursor' });
  const cursor = JSON.parse(readFileSync(path.join(directory, '.cursor', 'hooks.json'), 'utf8'));
  assert.equal(cursor.version, 1);
  assert.deepEqual(Object.keys(cursor.hooks), ['preToolUse']);
  assert.equal(cursor.hooks.preToolUse[0].matcher, 'Shell');
  assert.equal(cursor.hooks.preToolUse[0].failClosed, true);
  assert.match(cursor.hooks.preToolUse[0].command, /\[youdede:commit-guard\]/);
  removeArtifact('commit-guard', { cwd: directory, target: 'cursor' });
});

test('multiple native shell guards compose without settings or file collisions', (context) => {
  const slugs = ['commit-guard', 'outbound-data-guard', 'package-publish-guard'];
  for (const target of ['codex', 'gemini-cli', 'cursor', 'opencode']) {
    const directory = temporary(context, `youdede-${target}-composition-`);
    for (const slug of slugs) installArtifact(slug, { cwd: directory, target });
    assert.deepEqual(doctor({ cwd: directory, target }), {
      configRoot: resolveConfigRoot(target, 'project', directory, 'hook'),
      installs: slugs.length,
      findings: []
    });
    for (const slug of slugs.toReversed()) removeArtifact(slug, { cwd: directory, target });
    assert.equal(doctor({ cwd: directory, target }).installs, 0);
  }
});

test('OpenCode plugin blocks dangerous shell calls before execution', (context) => {
  const directory = temporary(context, 'youdede-opencode-hook-');
  installArtifact('shell-command-guard', { cwd: directory, target: 'opencode' });
  const plugin = path.join(directory, '.opencode', 'plugins', 'youdede-shell-command-guard.js');
  writeFileSync(path.join(path.dirname(plugin), 'package.json'), '{"type":"module"}\n');
  const script = `
    import { pathToFileURL } from 'node:url';
    const module = await import(pathToFileURL(process.argv[1]).href);
    const hooks = await module.YoudedeGuardPlugin({ directory: process.argv[2] });
    const command = process.argv[3];
    try {
      await hooks['tool.execute.before']({ tool: 'bash' }, { args: { command } });
      process.stdout.write('allowed');
    } catch (error) {
      process.stderr.write(String(error.message));
      process.exitCode = 2;
    }
  `;
  const run = (command) => spawnSync(process.execPath, ['--input-type=module', '-e', script, plugin, directory, command], { encoding: 'utf8' });
  const allowed = run('pwd');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, 'allowed');
  const blocked = run('rm -rf /');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED by shell-command-guard/);
  assert.deepEqual(doctor({ cwd: directory, target: 'opencode' }).findings, []);
  removeArtifact('shell-command-guard', { cwd: directory, target: 'opencode' });
});

test('project roots match native component directories', () => {
  const cwd = path.resolve(os.tmpdir(), 'youdede-config-root-example');
  assert.equal(resolveConfigRoot('codex', 'project', cwd, 'skill'), path.join(cwd, '.agents'));
  assert.equal(resolveConfigRoot('codex', 'project', cwd, 'hook'), path.join(cwd, '.codex'));
  assert.equal(resolveConfigRoot('codex', 'project', cwd, 'subagent'), path.join(cwd, '.codex'));
  assert.deepEqual(resolveConfigRoots('codex', 'project', cwd), [path.join(cwd, '.agents'), path.join(cwd, '.codex')]);
  assert.equal(resolveConfigRoot('gemini-cli', 'project', cwd), path.join(cwd, '.gemini'));
  assert.equal(resolveConfigRoot('github-copilot', 'project', cwd), path.join(cwd, '.github'));
  assert.equal(resolveConfigRoot('cursor', 'project', cwd), path.join(cwd, '.cursor'));
  assert.equal(resolveConfigRoot('opencode', 'project', cwd), path.join(cwd, '.opencode'));
});

test('Codex skill and hook installations coexist across component roots', (context) => {
  const directory = temporary(context, 'youdede-codex-multi-root-');
  installArtifact('debug-systematically', { cwd: directory, target: 'codex' });
  installArtifact('shell-command-guard', { cwd: directory, target: 'codex' });
  assert.ok(existsSync(path.join(directory, '.agents', 'skills', 'debug-systematically', 'SKILL.md')));
  assert.ok(existsSync(path.join(directory, '.codex', 'hooks', 'youdede', 'shell-command-guard.mjs')));
  assert.deepEqual(doctor({ cwd: directory, target: 'codex' }), {
    configRoot: null,
    configRoots: [path.join(directory, '.agents'), path.join(directory, '.codex')],
    installs: 2,
    findings: []
  });
  removeArtifact('shell-command-guard', { cwd: directory, target: 'codex' });
  removeArtifact('debug-systematically', { cwd: directory, target: 'codex' });
  assert.equal(doctor({ cwd: directory, target: 'codex' }).installs, 0);
});
