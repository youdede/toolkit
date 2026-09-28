import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  analyzeRelationshipGraph,
  loadPacks,
  publicCatalog,
  publicPackCatalog,
  subagentBodyDrift,
  unknownClaudeCodeSubagentTools,
  validateArtifact,
  validatePack,
  validateRelationshipIntegrity,
  validateRepository
} from '../scripts/lib/catalog.mjs';

test('all published JSON schemas parse as strict JSON', () => {
  const schemaDirectory = new URL('../schema/', import.meta.url);
  for (const entry of readdirSync(schemaDirectory).filter((name) => name.endsWith('.json'))) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(new URL(entry, schemaDirectory), 'utf8')), entry);
  }
});

test('all artifact manifests and adapters validate', () => {
  const { artifacts, results } = validateRepository();
  assert.ok(artifacts.length >= 113);
  const errors = results.flatMap(({ record, errors: found }) => found.map((error) => `${record.manifest.id}: ${error}`));
  assert.deepEqual(errors, []);
});

test('risk and latency reasons are required by both validator and schema', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/artifact.schema.json', import.meta.url), 'utf8'));
  assert.ok(schema.required.includes('risk_reason'));
  assert.ok(schema.properties.operational.required.includes('latency_reason'));
  const { artifacts, taxonomy } = validateRepository();
  for (const { manifest } of artifacts) {
    const keys = Object.keys(manifest);
    const operationalKeys = Object.keys(manifest.operational);
    assert.equal(keys.indexOf('risk_reason'), keys.indexOf('risk') + 1, manifest.id);
    assert.equal(operationalKeys.indexOf('latency_reason'), operationalKeys.indexOf('latencyClass') + 1, manifest.id);
    assert.doesNotMatch(manifest.risk_reason, /\b(?:not proven locally|boundaries remain unverified|not tested)\b/i, manifest.id);
  }
  const source = artifacts.find(({ manifest }) => manifest.kind === 'skill');
  for (const field of ['risk_reason', 'latency_reason']) {
    const broken = structuredClone(source);
    broken.adapters = source.adapters;
    if (field === 'risk_reason') broken.manifest.risk_reason = '  ';
    else broken.manifest.operational.latency_reason = '  ';
    const errors = validateArtifact(broken, taxonomy);
    assert.ok(errors.some((error) => error.includes(field)), field);
  }
});

test('classifications follow artifact authority rather than subject severity', () => {
  const byId = new Map(validateRepository().artifacts.map(({ manifest }) => [manifest.id, manifest]));
  assert.equal(byId.get('subagent/security/application-security/application-security-reviewer').risk, 'medium');
  assert.equal(byId.get('skill/data/migrations/review-database-migration-plan').risk, 'medium');
  assert.equal(byId.get('skill/operations/release/verify-production-release').risk, 'high');
  assert.equal(byId.get('skill/development/agent-tooling/publish-agent-skill').risk, 'high');
  assert.equal(byId.get('skill/operations/agent-orchestration/schedule-agent-runs').risk, 'high');
  assert.equal(byId.get('skill/operations/git/prepare-branch-integration').risk, 'high');
  assert.match(byId.get('mcp-server/development/agent-tooling/github-readonly').risk_reason, /GitHub token.*Docker server/);
  assert.match(byId.get('mcp-server/development/testing/playwright-local-isolated').risk_reason, /npx.*loopback web apps/);
  assert.equal(byId.get('hook/security/secrets/commit-guard').operational.latencyClass, 'bounded');
  assert.equal(byId.get('hook/development/resource-management/tool-output-budget-guard').operational.latencyClass, 'immediate');
  assert.equal(byId.get('hook/operations/delegation-budget/subagent-fanout-guard').operational.latencyClass, 'bounded');
  assert.equal(byId.get('command/development/workflow/verify-claims-against-output').operational.latencyClass, 'bounded');
});

test('skill trigger and refusal contracts stay stricter than format validity', () => {
  const { artifacts } = validateRepository();
  for (const { directory, manifest } of artifacts) {
    assert.ok(manifest.refuses.length >= 3, `${manifest.id} needs three refusal boundaries`);
    if (manifest.kind !== 'skill') continue;
    const raw = readFileSync(`${directory}/SKILL.md`, 'utf8');
    const frontmatterEnd = raw.indexOf('\n---\n', 4);
    const description = raw.slice(4, frontmatterEnd).match(/^description:\s*(.+)$/m)?.[1] || '';
    assert.match(description, /\bUse (?:when|for|before|after)\b/i, manifest.id);
    assert.ok(raw.split(/\r?\n/).length < 500, `${manifest.id} must stay below 500 lines`);
  }
});

test('every subagent target payload is validated, not just the first adapter', () => {
  const { artifacts, taxonomy } = validateRepository();
  const subagents = artifacts.filter(({ manifest }) => manifest.kind === 'subagent');
  assert.ok(subagents.length > 0);

  // Each target ships and installs its own payload, so a defect in a non-primary one must be
  // reported rather than hidden behind the first adapter.
  let checkedTargets = 0;
  for (const record of subagents) {
    const targets = Object.keys(record.adapters);
    assert.ok(targets.length >= 1, record.manifest.id);
    checkedTargets += targets.length;
    for (const target of targets) {
      const broken = structuredClone(record);
      broken.directory = record.directory;
      broken.manifestPath = record.manifestPath;
      broken.adapters = { [target]: record.adapters[target] };
      // Point this target's payload at a file that does not exist and require the error to
      // name the target it came from.
      broken.adapters[target] = structuredClone(record.adapters[target]);
      broken.adapters[target].data.files[0].from = 'targets/does-not-exist.md';
      const errors = validateArtifact(broken, taxonomy);
      assert.ok(errors.some((error) => error.startsWith(`${target}: `)), `${record.manifest.id} ${target}`);
    }
  }
  assert.ok(checkedTargets > subagents.length, 'subagents must span more than one target');
});

test('the published artifact schema and the repository validator describe the same contract', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/artifact.schema.json', import.meta.url), 'utf8'));
  const { artifacts } = validateRepository();
  assert.equal(schema.additionalProperties, false);

  const declared = new Set(Object.keys(schema.properties));
  const used = new Set();
  for (const { manifest, manifestPath } of artifacts) {
    for (const key of Object.keys(manifest)) {
      used.add(key);
      // `additionalProperties: false` is only meaningful if nothing in the repository violates
      // it. Nothing evaluates JSON Schema at runtime, so this test is the enforcement.
      assert.ok(declared.has(key), `${manifestPath} carries '${key}', absent from schema/artifact.schema.json`);
    }
    for (const key of schema.required) {
      assert.ok(Object.hasOwn(manifest, key), `${manifestPath} is missing required '${key}'`);
    }
  }

  // A property the schema declares but no artifact can use is drift in the other direction.
  // Kind-conditional contract objects may be introduced by the schema before their first artifact
  // lands; every implemented kind is removed from this allowance to restore the zero-drift invariant.
  const pendingKindContracts = [];
  const unused = [...declared].filter((key) => key !== '$schema' && !pendingKindContracts.includes(key) && !used.has(key));
  assert.deepEqual(unused, [], 'schema declares properties no artifact uses');
  for (const key of pendingKindContracts) {
    assert.ok(!used.has(key), `kind contract '${key}' now has artifacts: remove it from the pending allowance`);
  }
});

test('pack validation enforces its strict public schema surface', () => {
  const repository = validateRepository();
  const source = loadPacks().find(({ manifest }) => manifest.slug === 'accessibility-assurance');
  const record = structuredClone(source);
  record.directory = source.directory;
  record.manifestPath = source.manifestPath;
  record.manifest.unexpected = true;
  record.manifest.outcomes[0] = 'NOT A SLUG';
  record.manifest.evidence.unexpected = true;
  record.manifest.evidence.outcomeEvidence[0].extra = true;
  record.manifest.members[0].extra = true;
  const errors = validatePack(record, new Set(repository.artifacts.map(({ manifest }) => manifest.id)), repository.artifacts);
  assert.ok(errors.some((error) => /unexpected property 'unexpected'/.test(error)));
  assert.ok(errors.some((error) => /invalid slug/.test(error)));
  assert.ok(errors.some((error) => /evidence has unexpected property 'unexpected'/.test(error)));
  assert.ok(errors.some((error) => /outcomeEvidence\[0\].*unexpected property 'extra'/.test(error)));
  assert.ok(errors.some((error) => /members\[0\].*unexpected property 'extra'/.test(error)));
});

test('hook adapter validation rejects unknown lifecycle events', () => {
  const repository = validateRepository();
  const source = repository.artifacts.find(({ manifest }) => manifest.slug === 'prompt-secret-guard');
  const record = { ...source, adapters: structuredClone(source.adapters) };
  record.adapters['claude-code'].path = source.adapters['claude-code'].path;
  record.adapters['claude-code'].data.settingsPatch.hooks.UnknownFutureEvent = record.adapters['claude-code'].data.settingsPatch.hooks.UserPromptSubmit;
  delete record.adapters['claude-code'].data.settingsPatch.hooks.UserPromptSubmit;
  const errors = validateArtifact(record, repository.taxonomy);
  assert.ok(errors.some((error) => /not supported by this adapter contract/.test(error)));
});

test('public catalog is sorted and exposes individual install commands', () => {
  const { artifacts } = validateRepository();
  const catalog = publicCatalog(artifacts, 'test');
  const expectedCounts = {
    total: artifacts.length,
    skills: artifacts.filter(({ manifest }) => manifest.kind === 'skill').length,
    hooks: artifacts.filter(({ manifest }) => manifest.kind === 'hook').length,
    subagents: artifacts.filter(({ manifest }) => manifest.kind === 'subagent').length
  };
  assert.deepEqual(catalog.counts, expectedCounts);
  assert.equal(catalog.relationshipGraph.counts.artifactNodes, artifacts.length);
  assert.equal(catalog.relationshipGraph.orphanArtifactIds.length, catalog.relationshipGraph.counts.orphanArtifacts);
  assert.deepEqual(catalog.relationshipGraph.orphanArtifactIds, [...catalog.relationshipGraph.orphanArtifactIds].sort());
  assert.equal(
    Object.values(catalog.relationshipGraph.orphanCountsByKind).reduce((sum, count) => sum + count, 0),
    catalog.relationshipGraph.counts.orphanArtifacts
  );
  assert.ok(catalog.counts.skills >= 106);
  assert.ok(catalog.counts.hooks >= 50, 'the public catalogue must keep at least 50 hooks');
  assert.ok(catalog.counts.subagents >= 50, 'the public catalogue must keep at least 50 subagents');
  const executionCounts = catalog.artifacts.reduce((counts, artifact) => {
    counts[artifact.execution.mode] = (counts[artifact.execution.mode] || 0) + 1;
    return counts;
  }, {});
  assert.equal(Object.values(executionCounts).reduce((sum, count) => sum + count, 0), artifacts.length);
  assert.ok(executionCounts.deterministic >= 3);
  assert.ok(executionCounts.hybrid >= 3);
  const ids = catalog.artifacts.map((artifact) => artifact.id);
  assert.deepEqual(ids, [...ids].sort());
  for (const artifact of catalog.artifacts) {
    const source = artifacts.find(({ manifest }) => manifest.id === artifact.id).manifest;
    assert.equal(artifact.risk_reason, source.risk_reason);
    assert.equal(artifact.operational.latency_reason, source.operational.latency_reason);
    assert.ok(artifact.risk_reason.trim().length >= 25);
    assert.ok(artifact.operational.latency_reason.trim().length >= 25);
    assert.ok(artifact.install.length > 0);
    assert.match(artifact.install[0].command, new RegExp(`add ${artifact.slug}`));
    assert.ok(artifact.refuses.length >= 3);
    if (artifact.execution.mode === 'prompt') assert.deepEqual(artifact.execution.entrypoints, []);
    else assert.ok(artifact.execution.entrypoints.length > 0);
    if (artifact.kind === 'skill' && artifact.id !== 'skill/operations/session/resume-session-work') assert.ok(artifact.targets.includes('codex'));
    // The ledger library and its lifecycle hooks install only for Claude Code.
    if (artifact.id === 'skill/operations/session/resume-session-work') assert.deepEqual(artifact.targets, ['claude-code']);
  }
});

test('public catalogs are byte-reproducible and carry no generation timestamp', () => {
  const { artifacts, packs } = validateRepository();
  const first = JSON.stringify(publicCatalog(artifacts), null, 2);
  const second = JSON.stringify(publicCatalog(artifacts), null, 2);
  assert.equal(first, second);
  assert.equal(Object.hasOwn(publicCatalog(artifacts), 'generatedAt'), false);

  const firstPacks = JSON.stringify(publicPackCatalog(packs, artifacts), null, 2);
  const secondPacks = JSON.stringify(publicPackCatalog(packs, artifacts), null, 2);
  assert.equal(firstPacks, secondPacks);
  assert.equal(Object.hasOwn(publicPackCatalog(packs, artifacts), 'generatedAt'), false);

  // The committed files must equal a fresh build, so `--check` compares bytes rather
  // than a value it read back out of the file it is checking.
  const committed = readFileSync(new URL('../catalog/artifacts.json', import.meta.url), 'utf8');
  assert.equal(committed, `${first}\n`);
  const committedPacks = readFileSync(new URL('../catalog/packs.json', import.meta.url), 'utf8');
  assert.equal(committedPacks, `${firstPacks}\n`);
});

test('relationship integrity rejects contradictory edges and directional cycles', () => {
  const id = (slug) => `skill/development/testing/${slug}`;
  const result = (slug, relationships) => ({
    record: {
      manifest: {
        id: id(slug),
        kind: 'skill',
        relationships: {
          composesWith: [],
          conflictsWith: [],
          supersedes: [],
          prerequisites: [],
          packIds: [],
          ...relationships
        }
      }
    },
    errors: []
  });
  const results = [
    result('alpha', {
      composesWith: [id('beta')],
      conflictsWith: [id('beta')],
      prerequisites: [id('beta')]
    }),
    result('beta', {
      composesWith: [id('alpha')],
      conflictsWith: [id('alpha')],
      prerequisites: [id('alpha')]
    })
  ];

  validateRelationshipIntegrity(results, []);
  const errors = results.flatMap((entry) => entry.errors);
  assert.ok(errors.some((error) => /both compose and conflict/.test(error)));
  assert.ok(errors.some((error) => /both require and conflict/.test(error)));
  assert.ok(errors.some((error) => /prerequisites contains cycle/.test(error)));
});

test('relationship arrays must be sorted and orphan analysis is non-punitive', () => {
  const repository = validateRepository();
  const source = repository.artifacts.find(({ manifest }) => manifest.relationships.composesWith.length > 1);
  const record = { ...source, manifest: structuredClone(source.manifest) };
  record.manifest.relationships.composesWith.reverse();
  assert.ok(validateArtifact(record, repository.taxonomy).some((error) => /composesWith must be sorted/.test(error)));

  const graph = analyzeRelationshipGraph(repository.artifacts);
  assert.ok(graph.counts.orphanArtifacts > 0, 'standalone artifacts remain visible without becoming validation failures');
  assert.equal(graph.counts.compositionEdges * 2, graph.counts.directedEdges.composesWith);
  assert.ok(graph.counts.crossKindCompositionEdges > 0);
});

test('subagent bodies must match across targets apart from the Copilot turn budget line', () => {
  const body = '---\nname: x\n---\n\nYou review.\n\n## Refusals\n- a\n';
  assert.deepEqual(subagentBodyDrift({ 'claude-code': body, 'gemini-cli': body }), []);
  const copilot = body.replace('You review.\n', 'Complete the brief within 10 turns. Stop and return partial evidence instead of expanding the scope when that budget is exhausted.\n\nYou review.\n');
  assert.deepEqual(subagentBodyDrift({ 'claude-code': body, 'github-copilot': copilot }), []);
  assert.deepEqual(subagentBodyDrift({ 'claude-code': body, opencode: body.replace('You review.', 'You approve.') }), ['opencode']);
});

test('claude code subagents may only name the documented read-only tools', () => {
  // Source: https://code.claude.com/docs/en/tools-reference (read 2026-09-26) has no NotebookRead;
  // Read already returns .ipynb cells with outputs.
  assert.deepEqual(unknownClaudeCodeSubagentTools('Read, Grep, Glob'), []);
  assert.deepEqual(unknownClaudeCodeSubagentTools('Read, Grep, Glob, NotebookRead'), ['NotebookRead']);
});
