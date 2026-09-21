import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadTaxonomy, validateArtifact, validateRelationshipIntegrity } from '../scripts/lib/catalog.mjs';
import { installArtifact, removeArtifact } from '../scripts/lib/install.mjs';

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function baseManifest(kind, domain, category, slug) {
  return {
    schemaVersion: 1,
    id: `${kind}/${domain}/${category}/${slug}`,
    slug,
    name: slug.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' '),
    version: '1.0.0',
    kind,
    summary: `Fixture ${kind} exercising the ${slug} contract surface.`,
    description: `Deterministic fixture for kind-expansion validation of ${slug}; it exists only inside a temporary test repository.`,
    domain,
    category,
    capabilities: ['verify'],
    problems: ['workflow-delegation'],
    frameworks: ['agnostic'],
    languages: ['agnostic'],
    lifecycle: ['implementation'],
    risk: 'medium',
    license: 'MIT',
    authors: ['Youdede'],
    refuses: [
      'It does not mutate repository files outside its declared evidence output.',
      'It does not expand its tool authority beyond the declared allowlist.',
      'It does not claim completion without the declared evidence artifact.'
    ],
    execution: { mode: 'prompt', entrypoints: [] },
    relationships: { composesWith: [], conflictsWith: [], supersedes: [], prerequisites: [], packIds: [] },
    operational: { behavior: 'advisory', failurePolicy: 'stop-and-report', latencyClass: 'immediate', dataRetention: 'none' },
    adapters: { 'claude-code': 'adapters/claude-code.json' }
  };
}

function commandContract(overrides = {}) {
  return {
    invocation: 'draft-evidenced-plan',
    toolAuthority: ['Read', 'Grep', 'Glob'],
    produces: ['an ordered implementation plan with code anchors'],
    requires: [],
    flags: [{ name: 'scope', effect: 'narrow', description: 'Restrict the plan to a bounded path set.' }],
    ...overrides
  };
}

function contextContract(overrides = {}) {
  return {
    scope: 'always',
    precedence: 100,
    provenance: ['skill/development/testing/deliver-test-first'],
    rules: [{
      id: 'deliver-test-first',
      effect: 'require',
      action: 'deliver-test-first',
      sourceArtifactId: 'skill/development/testing/deliver-test-first',
      sourceField: 'summary'
    }],
    ...overrides
  };
}

function mcpServerContract(overrides = {}) {
  return {
    transport: 'stdio',
    egress: ['none'],
    secretAccess: ['none'],
    trustBoundary: 'The server reads only the declared workspace subtree and never reaches the network.',
    pinnedTools: [{ name: 'read_file', descriptionHash: 'a'.repeat(64) }],
    ...overrides
  };
}

function createFixture(root, kind, domain, category, slug, contractKey, contract, manifestOverrides = {}) {
  const plural = { skill: 'skills', hook: 'hooks', subagent: 'subagents', command: 'commands', context: 'contexts', 'mcp-server': 'mcp-servers' }[kind];
  const directory = path.join(root, 'artifacts', plural, domain, category, slug);
  mkdirSync(path.join(directory, 'adapters'), { recursive: true });
  writeFileSync(path.join(directory, 'payload.md'), `# ${slug}\n`);
  if (kind === 'command') {
    writeFileSync(path.join(directory, 'COMMAND.md'), [
      '---',
      `description: Draft a bounded outcome for ${slug}. Use when the fixture requests it.`,
      `allowed-tools: ${(contract?.toolAuthority || []).join(', ')}`,
      '---',
      '',
      '## Refusals',
      '- It does not edit files outside its declared evidence output.',
      '- It does not expand beyond its declared tool allowlist.',
      '- It does not claim completion without its declared evidence.',
      ''
    ].join('\n'));
    writeJson(path.join(directory, 'preconditions.json'), { checks: [] });
  }
  const manifest = { ...baseManifest(kind, domain, category, slug), ...manifestOverrides };
  if (contractKey) manifest[contractKey] = contract;
  writeJson(path.join(directory, 'artifact.json'), manifest);
  writeJson(path.join(directory, 'adapters', 'claude-code.json'), {
    schemaVersion: 1,
    target: 'claude-code',
    scopes: ['project'],
    files: [{ from: 'payload.md', to: `${plural}/${slug}/payload.md` }]
  });
  if (kind === 'mcp-server') {
    const adapterPath = path.join(directory, 'adapters', 'claude-code.json');
    const adapter = JSON.parse(readFileSync(adapterPath, 'utf8'));
    adapter.mcpPatch = {
      path: '.mcp.json',
      servers: {
        [`youdede-${slug}`]: { command: 'node', args: [`mcp-servers/${slug}/payload.md`] }
      }
    };
    writeJson(adapterPath, adapter);
  }
  if (kind === 'command') {
    const adapterPath = path.join(directory, 'adapters', 'claude-code.json');
    const adapter = JSON.parse(readFileSync(adapterPath, 'utf8'));
    adapter.files.push({ from: 'COMMAND.md', to: `commands/${slug}.md` });
    writeJson(adapterPath, adapter);
  }
  return directory;
}

function validateFixture(root, kind, domain, category, slug, contractKey, contract, manifestOverrides = {}) {
  const directory = createFixture(root, kind, domain, category, slug, contractKey, contract, manifestOverrides);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'artifact.json'), 'utf8'));
  const adapters = { 'claude-code': { path: path.join(directory, 'adapters', 'claude-code.json'), data: JSON.parse(readFileSync(path.join(directory, 'adapters', 'claude-code.json'), 'utf8')) } };
  return validateArtifact({ root, directory, manifest, adapters }, loadTaxonomy(), path.join(root, 'artifacts'));
}

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kind-expansion-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('taxonomy admits the new kinds and their categories', () => {
  const taxonomy = loadTaxonomy();
  for (const kind of ['command', 'context', 'mcp-server']) assert.ok(taxonomy.kinds.includes(kind), `missing kind ${kind}`);
  assert.ok(taxonomy.domains.development.includes('workflow'));
  assert.ok(taxonomy.domains.operations.includes('session'));
});

test('a well-formed command fixture validates', () => withTempRoot((root) => {
  const errors = validateFixture(root, 'command', 'development', 'workflow', 'draft-evidenced-plan', 'command', commandContract());
  assert.deepEqual(errors, []);
}));

test('command contracts reject missing contract, mismatched invocation, and widening flags', () => withTempRoot((root) => {
  let errors = validateFixture(root, 'command', 'development', 'workflow', 'draft-evidenced-plan', null, null);
  assert.ok(errors.some((error) => error.includes('require a command contract')));

  errors = validateFixture(root, 'command', 'development', 'workflow', 'draft-evidenced-plan', 'command', commandContract({ invocation: 'other-name' }));
  assert.ok(errors.some((error) => error.includes('invocation must match the slug')));

  errors = validateFixture(root, 'command', 'development', 'workflow', 'draft-evidenced-plan', 'command', commandContract({ flags: [{ name: 'yolo', effect: 'expand', description: 'Grants broader authority than declared.' }] }));
  assert.ok(errors.some((error) => error.includes("effect must be 'narrow'")));

  errors = validateFixture(root, 'command', 'development', 'workflow', 'draft-evidenced-plan', 'command', commandContract({ produces: [] }));
  assert.ok(errors.some((error) => error.includes('command.produces')));
}));

test('context contracts enforce scope, provenance, and prompt-only execution', () => withTempRoot((root) => {
  const errors = validateFixture(root, 'context', 'development', 'workflow', 'coding-style-baseline', 'context', contextContract());
  assert.deepEqual(errors, []);

  const globErrors = validateFixture(root, 'context', 'development', 'workflow', 'coding-style-baseline', 'context', contextContract({ scope: 'glob' }));
  assert.ok(globErrors.some((error) => error.includes('require a non-empty globs list')));

  const traversal = validateFixture(root, 'context', 'development', 'workflow', 'coding-style-baseline', 'context', contextContract({ scope: 'glob', globs: ['../escape/**'] }));
  assert.ok(traversal.some((error) => error.includes('not a safe portable relative glob')));

  const windowsPath = validateFixture(root, 'context', 'development', 'workflow', 'coding-style-baseline', 'context', contextContract({ scope: 'glob', globs: ['C:\\source\\**'] }));
  assert.ok(windowsPath.some((error) => error.includes('not a safe portable relative glob')));

  const expiry = validateFixture(root, 'context', 'development', 'workflow', 'coding-style-baseline', 'context', contextContract({ expires: '2027-02-30' }));
  assert.ok(expiry.some((error) => error.includes('real ISO calendar date')));

  const provenance = validateFixture(root, 'context', 'development', 'workflow', 'coding-style-baseline', 'context', contextContract({ provenance: [] }));
  assert.ok(provenance.some((error) => error.includes('context.provenance')));
}));

test('mcp-server contracts enforce egress, secret, and pinned-tool discipline', () => withTempRoot((root) => {
  const errors = validateFixture(root, 'mcp-server', 'development', 'agent-tooling', 'workspace-fs-readonly', 'mcpServer', mcpServerContract());
  assert.deepEqual(errors, []);

  const mixed = validateFixture(root, 'mcp-server', 'development', 'agent-tooling', 'workspace-fs-readonly', 'mcpServer', mcpServerContract({ egress: ['none', 'api.example.com'] }));
  assert.ok(mixed.some((error) => error.includes('may not be combined')));

  const badHash = validateFixture(root, 'mcp-server', 'development', 'agent-tooling', 'workspace-fs-readonly', 'mcpServer', mcpServerContract({ pinnedTools: [{ name: 'read_file', descriptionHash: 'not-a-hash' }] }));
  assert.ok(badHash.some((error) => error.includes('sha256')));

  const risky = validateFixture(root, 'mcp-server', 'development', 'agent-tooling', 'workspace-fs-readonly', 'mcpServer', mcpServerContract({ egress: ['api.example.com'] }), { risk: 'low' });
  assert.ok(risky.some((error) => error.includes('may not declare low risk')));
}));

test('context provenance references must resolve to known artifacts', () => {
  const manifest = baseManifest('context', 'development', 'workflow', 'coding-style-baseline');
  manifest.context = contextContract({ provenance: ['skill/development/testing/not-a-real-skill'] });
  const results = [{ record: { manifest }, errors: [] }];
  validateRelationshipIntegrity(results, []);
  assert.ok(results[0].errors.some((error) => error.includes('context.provenance references unknown artifact')));
});

test('a command fixture installs and removes cleanly through its adapter', () => withTempRoot((root) => {
  createFixture(root, 'command', 'development', 'workflow', 'draft-evidenced-plan', 'command', commandContract());
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  installArtifact('draft-evidenced-plan', { root, target: 'claude-code', scope: 'project', cwd: project });
  const installed = path.join(project, '.claude', 'commands', 'draft-evidenced-plan', 'payload.md');
  assert.ok(existsSync(installed), 'expected the command payload at its adapter destination');
  removeArtifact('draft-evidenced-plan', { root, target: 'claude-code', scope: 'project', cwd: project });
  assert.ok(!existsSync(installed), 'expected removal to delete the installed payload');
}));

test('command payload governance rejects tool drift and escaping destinations', () => withTempRoot((root) => {
  const directory = createFixture(root, 'command', 'development', 'workflow', 'draft-evidenced-plan', 'command', commandContract());
  const manifest = JSON.parse(readFileSync(path.join(directory, 'artifact.json'), 'utf8'));
  const adapters = { 'claude-code': { path: path.join(directory, 'adapters', 'claude-code.json'), data: JSON.parse(readFileSync(path.join(directory, 'adapters', 'claude-code.json'), 'utf8')) } };

  const drifted = structuredClone(manifest);
  drifted.command.toolAuthority = ['Read'];
  const drift = validateArtifact({ root, directory, manifest: drifted, adapters }, loadTaxonomy(), path.join(root, 'artifacts'));
  assert.ok(drift.some((error) => error.includes('allowed-tools must match command.toolAuthority')));

  const escaped = structuredClone(adapters);
  escaped['claude-code'].data.files[0].to = 'hooks/payload.md';
  const outside = validateArtifact({ root, directory, manifest, adapters: escaped }, loadTaxonomy(), path.join(root, 'artifacts'));
  assert.ok(outside.some((error) => error.includes('must stay under commands/')));
}));

test('the shipped draft-evidenced-plan installs, evaluates preconditions, and removes cleanly', () => withTempRoot((root) => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  installArtifact('draft-evidenced-plan', { root: repoRoot, target: 'claude-code', scope: 'project', cwd: project });
  const commandFile = path.join(project, '.claude', 'commands', 'draft-evidenced-plan.md');
  const wrapper = path.join(project, '.claude', 'commands', 'youdede', 'draft-evidenced-plan', 'check-preconditions.mjs');
  const bridge = path.join(project, '.claude', 'commands', 'youdede', 'lib', 'command-precondition.mjs');
  for (const file of [commandFile, wrapper, bridge]) assert.ok(existsSync(file), `expected ${file}`);
  const run = spawnSync(process.execPath, [wrapper], { cwd: project, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout);
  assert.equal(JSON.parse(run.stdout.trim()).ok, true);
  removeArtifact('draft-evidenced-plan', { root: repoRoot, target: 'claude-code', scope: 'project', cwd: project });
  assert.ok(!existsSync(commandFile), 'expected removal to delete the installed command');
}));
