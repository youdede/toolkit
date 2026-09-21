import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generateCapabilityDocs, renderCapabilityMatrix } from '../scripts/generate-capability-docs.mjs';
import { ROOT, validateRepository } from '../scripts/lib/catalog.mjs';

test('capability matrix is byte-current and covers every kind and pack', () => {
  const file = path.join(ROOT, 'docs', 'capability-matrix.md');
  const content = readFileSync(file, 'utf8');
  const repository = validateRepository();
  assert.equal(content, renderCapabilityMatrix());
  assert.equal(generateCapabilityDocs({ check: true }), false);
  for (const kind of ['skill', 'hook', 'subagent', 'command', 'context', 'mcp-server']) {
    assert.ok(content.includes(`| \`${kind}\` |`), kind);
  }
  for (const { manifest } of repository.packs) {
    assert.ok(content.includes(`[${manifest.name}]`), manifest.id);
  }
});

test('capability claims name the enforced evidence and publication boundaries', () => {
  const content = renderCapabilityMatrix();
  assert.match(content, /preconditions/);
  assert.match(content, /hash-chained checkpoints/);
  assert.match(content, /tool-description hashes/);
  assert.match(content, /hash-linked session-ledger/);
  assert.match(content, /not authorship or semantic correctness/);
  assert.match(content, /provenance-capable OIDC workflow/);
});
