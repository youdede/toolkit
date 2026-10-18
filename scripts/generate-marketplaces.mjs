#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArtifacts, loadPacks, ROOT } from './lib/catalog.mjs';

const CLAUDE_SCHEMA = 'https://json.schemastore.org/claude-code-plugin-manifest.json';
const REPOSITORY = 'https://github.com/youdede/toolkit';
const AUTHOR = { name: 'Youdede', url: REPOSITORY };
const CODEX_PLUGIN = 'youdede-toolkit';
const NATIVE_KINDS = new Set(['skill', 'hook', 'subagent', 'command', 'mcp-server']);
const ROOT_MANIFESTS = [
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
  '.codex-plugin/plugin.json',
  'catalog/native-marketplaces.json'
];

function json(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function walkFiles(source, relative = '') {
  const absolute = path.join(source, relative);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink()) throw new Error(`native package source contains symbolic link '${absolute}'`);
  if (metadata.isFile()) return [relative];
  if (!metadata.isDirectory()) throw new Error(`native package source is unsupported '${absolute}'`);
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => walkFiles(source, path.join(relative, entry.name)))
    .sort((left, right) => left.localeCompare(right));
}

function addOutput(outputs, relative, content, executable = false) {
  const normalized = relative.split(path.sep).join('/');
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const existing = outputs.get(normalized);
  if (existing && (!existing.content.equals(bytes) || existing.executable !== executable)) {
    throw new Error(`native packages produce conflicting bytes for '${normalized}'`);
  }
  outputs.set(normalized, { content: bytes, executable });
}

function rewriteClaudeMarkdown(content) {
  return content
    .replaceAll('${CLAUDE_PROJECT_DIR}/.claude/commands/', '${CLAUDE_PLUGIN_ROOT}/commands/')
    .replaceAll('${CLAUDE_PROJECT_DIR}/.claude/hooks/', '${CLAUDE_PLUGIN_ROOT}/hooks/');
}

function copyAdapter(outputs, record, adapter, packageRoot, target) {
  for (const mapping of adapter.files) {
    const sourceRoot = mapping.root === 'package' ? ROOT : record.directory;
    const source = path.resolve(sourceRoot, mapping.from);
    if (!within(sourceRoot, source) || !existsSync(source)) {
      if (mapping.optional) continue;
      throw new Error(`${record.manifest.id} has missing native source '${mapping.from}'`);
    }
    const metadata = lstatSync(source);
    if (metadata.isSymbolicLink()) throw new Error(`${record.manifest.id} native source is a symbolic link`);
    const leaves = metadata.isFile() ? [''] : walkFiles(source);
    const destination = mapping.to.replaceAll('{slug}', record.manifest.slug);
    for (const leaf of leaves) {
      const sourceFile = leaf ? path.join(source, leaf) : source;
      const output = leaf ? path.join(packageRoot, destination, leaf) : path.join(packageRoot, destination);
      let content = readFileSync(sourceFile);
      if (target === 'claude-code' && output.endsWith('.md')) content = Buffer.from(rewriteClaudeMarkdown(content.toString('utf8')));
      addOutput(outputs, output, content, Boolean(mapping.executable));
    }
  }
}

function mergeClaudeHooks(records) {
  const hooks = {};
  for (const record of records) {
    const patch = record.adapters['claude-code']?.data.settingsPatch?.hooks || {};
    for (const [event, entries] of Object.entries(patch)) {
      hooks[event] ||= [];
      for (const entry of entries) {
        const rendered = JSON.parse(JSON.stringify(entry).replaceAll('{claudeRoot}', '${CLAUDE_PLUGIN_ROOT}'));
        hooks[event].push(rendered);
      }
    }
  }
  return Object.fromEntries(Object.entries(hooks).sort(([left], [right]) => left.localeCompare(right)));
}

function mergeClaudeMcp(records) {
  const servers = {};
  for (const record of records) {
    const entries = record.adapters['claude-code']?.data.mcpPatch?.servers || {};
    for (const [name, value] of Object.entries(entries)) {
      if (Object.hasOwn(servers, name)) throw new Error(`duplicate native MCP server '${name}'`);
      const rendered = structuredClone(value);
      rendered.args = (rendered.args || []).map((argument) => typeof argument === 'string' && argument.startsWith('.youdede/')
        ? `\${CLAUDE_PLUGIN_ROOT}/${argument}`
        : argument);
      servers[name] = rendered;
    }
  }
  return Object.fromEntries(Object.entries(servers).sort(([left], [right]) => left.localeCompare(right)));
}

function evidenceBadges(pack) {
  const badges = [];
  if (pack.evidence?.ledgerLinkRequired) badges.push('ledger-linked-evidence');
  badges.push('behaviorally-evaluated');
  return badges;
}

function claudePackOutputs(outputs, pack, records) {
  const packageRoot = path.join('plugins', pack.slug);
  for (const record of records) copyAdapter(outputs, record, record.adapters['claude-code'].data, packageRoot, 'claude-code');
  const hooks = mergeClaudeHooks(records);
  const servers = mergeClaudeMcp(records);
  if (Object.keys(hooks).length) addOutput(outputs, path.join(packageRoot, 'hooks/hooks.json'), json({ hooks }));
  if (Object.keys(servers).length) addOutput(outputs, path.join(packageRoot, '.mcp.json'), json({ mcpServers: servers }));
  addOutput(outputs, path.join(packageRoot, 'LICENSE'), readFileSync(path.join(ROOT, 'LICENSE')));
  addOutput(outputs, path.join(packageRoot, 'NOTICE'), readFileSync(path.join(ROOT, 'NOTICE')));

  const refusalCount = records.reduce((total, record) => total + record.manifest.refuses.length, 0);
  const manifest = {
    $schema: CLAUDE_SCHEMA,
    name: pack.slug,
    displayName: pack.name,
    version: pack.version,
    description: pack.summary,
    author: AUTHOR,
    homepage: `${REPOSITORY}/blob/main/packs/${pack.slug}/pack.json`,
    repository: REPOSITORY,
    license: 'MIT',
    keywords: [...pack.outcomes, ...evidenceBadges(pack)],
    ...(Object.keys(hooks).length ? { hooks: './hooks/hooks.json' } : {}),
    ...(Object.keys(servers).length ? { mcpServers: './.mcp.json' } : {}),
    metadata: {
      catalogId: pack.id,
      memberArtifactIds: records.map((record) => record.manifest.id),
      refusalCount,
      evidenceBadges: evidenceBadges(pack)
    }
  };
  addOutput(outputs, path.join(packageRoot, '.claude-plugin/plugin.json'), json(manifest));
  return { packageRoot: `./plugins/${pack.slug}`, refusalCount, manifest };
}

function codexManifest(version, skillsPath, skillCount, refusalCount) {
  const shortDescription = `${skillCount} catalog skills with explicit refusal boundaries`;
  return {
    name: CODEX_PLUGIN,
    version,
    description: `${skillCount} coding-agent skills with ${refusalCount} declared refusal boundaries.`,
    author: AUTHOR,
    homepage: `${REPOSITORY}#readme`,
    repository: REPOSITORY,
    license: 'MIT',
    keywords: ['coding-agents', 'skills', 'evidence', 'refusal-boundaries'],
    skills: skillsPath,
    interface: {
      displayName: 'Youdede toolkit',
      shortDescription,
      longDescription: `${skillCount} inspectable skill artifacts generated from the catalog, carrying ${refusalCount} declared refusal boundaries.`,
      developerName: 'Youdede',
      category: 'Developer Tools',
      capabilities: ['Workflow'],
      defaultPrompt: [
        'Find a relevant toolkit skill for this task.',
        'Apply the selected skill and preserve its refusal boundaries.',
        'State which evidence the selected skill requires.'
      ]
    }
  };
}

export function expectedMarketplaceOutputs(root = ROOT) {
  if (root !== ROOT) throw new Error('alternate roots are not supported by native marketplace generation');
  const outputs = new Map();
  const artifacts = loadArtifacts(root);
  const packs = loadPacks(root);
  const byId = new Map(artifacts.map((record) => [record.manifest.id, record]));
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

  const claudeEntries = [];
  const omitted = [];
  for (const { manifest: pack } of packs.sort((left, right) => left.manifest.slug.localeCompare(right.manifest.slug))) {
    const records = pack.members.map(({ artifactId }) => byId.get(artifactId));
    const unsupported = records.filter((record) => !record?.adapters['claude-code'] || !NATIVE_KINDS.has(record.manifest.kind));
    if (unsupported.length) {
      omitted.push({ packId: pack.id, unsupportedArtifactIds: unsupported.map((record) => record?.manifest.id || 'missing') });
      continue;
    }
    const generated = claudePackOutputs(outputs, pack, records);
    claudeEntries.push({
      name: pack.slug,
      source: generated.packageRoot,
      description: pack.summary,
      version: pack.version,
      author: AUTHOR,
      homepage: generated.manifest.homepage,
      repository: REPOSITORY,
      license: 'MIT',
      keywords: generated.manifest.keywords,
      tags: [...evidenceBadges(pack), `refusals-${generated.refusalCount}`],
      metadata: { catalogId: pack.id, refusalCount: generated.refusalCount, evidenceBadges: evidenceBadges(pack) }
    });
  }
  addOutput(outputs, '.claude-plugin/marketplace.json', json({
    name: 'youdede-toolkit',
    owner: AUTHOR,
    version: packageJson.version,
    description: `${claudeEntries.length} complete evidence-backed workflow packs generated from the catalog; ${omitted.length} composition omitted where native semantics are incomplete.`,
    plugins: claudeEntries
  }));

  const codexRoot = path.join('plugins', CODEX_PLUGIN);
  const codexSkills = artifacts
    .filter((record) => record.manifest.kind === 'skill' && record.adapters.codex)
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  for (const record of codexSkills) {
    copyAdapter(outputs, record, record.adapters.codex.data, codexRoot, 'codex');
    copyAdapter(outputs, record, record.adapters.codex.data, '', 'codex');
  }
  addOutput(outputs, path.join(codexRoot, 'LICENSE'), readFileSync(path.join(root, 'LICENSE')));
  addOutput(outputs, path.join(codexRoot, 'NOTICE'), readFileSync(path.join(root, 'NOTICE')));
  const refusalCount = codexSkills.reduce((total, record) => total + record.manifest.refuses.length, 0);
  const packagedManifest = codexManifest(packageJson.version, './skills/', codexSkills.length, refusalCount);
  addOutput(outputs, path.join(codexRoot, '.codex-plugin/plugin.json'), json(packagedManifest));
  addOutput(outputs, '.codex-plugin/plugin.json', json(codexManifest(packageJson.version, './skills/', codexSkills.length, refusalCount)));
  addOutput(outputs, '.agents/plugins/marketplace.json', json({
    name: 'youdede-toolkit',
    interface: { displayName: 'Youdede toolkit' },
    plugins: [{
      name: CODEX_PLUGIN,
      source: { source: 'local', path: './plugins/youdede-toolkit' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools'
    }]
  }));
  addOutput(outputs, 'catalog/native-marketplaces.json', json({
    $schema: '../schema/native-marketplace.schema.json',
    schemaVersion: 1,
    generatedBy: 'scripts/generate-marketplaces.mjs',
    claudeCode: {
      pluginCount: claudeEntries.length,
      plugins: claudeEntries.map((entry) => ({
        packId: entry.metadata.catalogId,
        name: entry.name,
        source: entry.source,
        refusalCount: entry.metadata.refusalCount,
        evidenceBadges: entry.metadata.evidenceBadges
      })),
      omitted
    },
    codex: {
      pluginCount: 1,
      plugins: [{ name: CODEX_PLUGIN, source: './plugins/youdede-toolkit', skillCount: codexSkills.length, refusalCount }],
      withheldKinds: ['command', 'context', 'hook', 'mcp-server', 'subagent']
    }
  }));
  return outputs;
}

function actualManagedPaths(root) {
  const found = new Set(ROOT_MANIFESTS.filter((relative) => existsSync(path.join(root, relative))));
  const pluginRoot = path.join(root, 'plugins');
  if (existsSync(pluginRoot)) {
    for (const relative of walkFiles(pluginRoot)) found.add(path.join('plugins', relative).split(path.sep).join('/'));
  }
  const skillRoot = path.join(root, 'skills');
  if (existsSync(skillRoot)) {
    for (const relative of walkFiles(skillRoot)) found.add(path.join('skills', relative).split(path.sep).join('/'));
  }
  return found;
}

export function generateMarketplaces({ root = ROOT, check = false } = {}) {
  const outputs = expectedMarketplaceOutputs(root);
  const actual = actualManagedPaths(root);
  const stale = [];
  for (const [relative, expected] of outputs) {
    const file = path.join(root, relative);
    const matches = existsSync(file)
      && lstatSync(file).isFile()
      && !lstatSync(file).isSymbolicLink()
      && readFileSync(file).equals(expected.content)
      && Boolean(lstatSync(file).mode & 0o111) === expected.executable;
    if (!matches) stale.push(relative);
    actual.delete(relative);
  }
  stale.push(...[...actual].sort().map((relative) => `${relative} (unexpected)`));
  if (check) {
    if (stale.length) throw new Error(`native marketplace outputs are stale: ${stale.join(', ')}`);
    return { files: outputs.size, stale: [] };
  }

  rmSync(path.join(root, 'plugins'), { recursive: true, force: true });
  rmSync(path.join(root, 'skills'), { recursive: true, force: true });
  for (const [relative, expected] of outputs) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, expected.content);
    chmodSync(file, expected.executable ? 0o755 : 0o644);
  }
  return { files: outputs.size, stale };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = generateMarketplaces({ check: process.argv.includes('--check') });
    process.stdout.write(`${process.argv.includes('--check') ? 'Verified' : 'Generated'} ${result.files} native marketplace files.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
