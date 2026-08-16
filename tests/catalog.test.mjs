import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  analyzeRelationshipGraph,
  loadPacks,
  publicCatalog,
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

test('pack validation enforces its strict public schema surface', () => {
  const repository = validateRepository();
  const source = loadPacks().find(({ manifest }) => manifest.slug === 'accessibility-assurance');
  const record = structuredClone(source);
  record.directory = source.directory;
  record.manifestPath = source.manifestPath;
  record.manifest.unexpected = true;
  record.manifest.outcomes[0] = 'NOT A SLUG';
  record.manifest.members[0].extra = true;
  const errors = validatePack(record, new Set(repository.artifacts.map(({ manifest }) => manifest.id)), repository.artifacts);
  assert.ok(errors.some((error) => /unexpected property 'unexpected'/.test(error)));
  assert.ok(errors.some((error) => /invalid slug/.test(error)));
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
    assert.ok(artifact.install.length > 0);
    assert.match(artifact.install[0].command, new RegExp(`add ${artifact.slug}`));
    assert.ok(artifact.refuses.length >= 3);
    if (artifact.execution.mode === 'prompt') assert.deepEqual(artifact.execution.entrypoints, []);
    else assert.ok(artifact.execution.entrypoints.length > 0);
    if (artifact.kind === 'skill') assert.ok(artifact.targets.includes('codex'));
  }
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
