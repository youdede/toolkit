import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadArtifacts, loadPacks, ROOT } from '../scripts/lib/catalog.mjs';
import { expectedMarketplaceOutputs, generateMarketplaces } from '../scripts/generate-marketplaces.mjs';

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
}

test('native marketplace generation is byte-current and deterministic', () => {
  const first = expectedMarketplaceOutputs();
  const second = expectedMarketplaceOutputs();
  assert.ok(first.size > 800);
  assert.deepEqual([...first.keys()], [...second.keys()]);
  for (const [file, expected] of first) assert.ok(expected.content.equals(second.get(file).content), file);
  assert.doesNotThrow(() => generateMarketplaces({ check: true }));
});

test('Claude marketplace publishes only complete native pack compositions', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const report = readJson('catalog/native-marketplaces.json');
  const artifacts = loadArtifacts();
  const byId = new Map(artifacts.map((record) => [record.manifest.id, record]));
  const packs = loadPacks().map(({ manifest }) => manifest);
  assert.equal(marketplace.plugins.length, 12);
  assert.deepEqual(report.claudeCode.omitted, [{
    packId: 'pack/plan-and-verify-loop',
    unsupportedArtifactIds: ['context/development/code-quality/coding-style-baseline', 'context/development/testing/testing-baseline']
  }]);

  for (const entry of marketplace.plugins) {
    const pack = packs.find(({ slug }) => slug === entry.name);
    assert.ok(pack, entry.name);
    assert.equal(entry.description, pack.summary);
    assert.equal(entry.version, pack.version);
    assert.deepEqual(entry.metadata.evidenceBadges, ['ledger-linked-evidence', 'behaviorally-evaluated']);
    const manifest = readJson(`${entry.source.slice(2)}/.claude-plugin/plugin.json`);
    assert.equal(manifest.description, pack.summary);
    assert.deepEqual(manifest.metadata.memberArtifactIds, pack.members.map(({ artifactId }) => artifactId));
    assert.equal(manifest.metadata.refusalCount, pack.members.reduce((total, member) => total + byId.get(member.artifactId).manifest.refuses.length, 0));
    for (const member of pack.members) {
      const record = byId.get(member.artifactId);
      assert.ok(record.adapters['claude-code'], `${pack.id}:${member.artifactId}`);
      for (const mapping of record.adapters['claude-code'].data.files) {
        const destination = mapping.to.replaceAll('{slug}', record.manifest.slug);
        assert.ok(existsSync(path.join(ROOT, entry.source, destination)), `${pack.id}:${destination}`);
      }
    }
  }
});

test('Claude package bridges use the plugin root and never pretend context support', () => {
  const command = readFileSync(path.join(ROOT, 'plugins/session-continuity/commands/record-work-checkpoint.md'), 'utf8');
  assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}\/commands/);
  assert.doesNotMatch(command, /CLAUDE_PROJECT_DIR.*\.claude\/commands/);

  const hooks = readJson('plugins/session-continuity/hooks/hooks.json');
  const hookCommands = Object.values(hooks.hooks).flat().flatMap((entry) => entry.hooks).map(({ command: value }) => value);
  assert.ok(hookCommands.every((value) => value.includes('${CLAUDE_PLUGIN_ROOT}/hooks/')));

  const mcp = readJson('plugins/mcp-baseline/.mcp.json');
  assert.ok(Object.values(mcp.mcpServers).every((server) => server.args.some((value) => value.startsWith('${CLAUDE_PLUGIN_ROOT}/.youdede/'))));
  assert.equal(existsSync(path.join(ROOT, 'plugins/plan-and-verify-loop')), false);
});

test('Codex marketplace exposes every supported skill and withholds unsupported kinds', () => {
  const marketplace = readJson('.agents/plugins/marketplace.json');
  const report = readJson('catalog/native-marketplaces.json');
  const manifest = readJson('plugins/youdede-toolkit/.codex-plugin/plugin.json');
  const rootManifest = readJson('.codex-plugin/plugin.json');
  const expectedSkills = loadArtifacts()
    .filter((record) => record.manifest.kind === 'skill' && record.adapters.codex)
    .map((record) => record.manifest.slug)
    .sort();
  const packagedSkills = readdirSync(path.join(ROOT, 'plugins/youdede-toolkit/skills')).sort();
  const rootSkills = readdirSync(path.join(ROOT, 'skills')).sort();

  assert.deepEqual(packagedSkills, expectedSkills);
  assert.deepEqual(rootSkills, expectedSkills);
  assert.equal(manifest.skills, './skills/');
  assert.equal(rootManifest.skills, './skills/');
  assert.equal(manifest.interface.defaultPrompt.length, 3);
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);
  assert.deepEqual(report.codex.withheldKinds, ['command', 'context', 'hook', 'mcp-server', 'subagent']);
  assert.deepEqual(marketplace.plugins[0].policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.equal(marketplace.plugins[0].source.path, './plugins/youdede-toolkit');
});
