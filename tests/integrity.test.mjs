import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadArtifacts, ROOT } from '../scripts/lib/catalog.mjs';
import {
  buildArtifactAttestation,
  buildIntegrityManifest,
  readIntegrityManifest,
  verifyArtifactAttestation,
  verifyIntegrityManifest
} from '../scripts/lib/integrity.mjs';

test('published per-artifact attestations are deterministic and current', () => {
  const artifacts = loadArtifacts(ROOT);
  const expected = readIntegrityManifest(ROOT);
  assert.deepEqual(buildIntegrityManifest(artifacts), expected);
  assert.deepEqual(verifyIntegrityManifest(artifacts, expected).findings, []);
  assert.match(expected.rootDigest, /^[a-f0-9]{64}$/);
});

test('artifact verification detects modified, missing, and unexpected payload bytes', (context) => {
  const source = loadArtifacts(ROOT).find(({ manifest }) => manifest.slug === 'debug-systematically');
  const expected = buildArtifactAttestation(source);
  const repository = mkdtempSync(path.join(os.tmpdir(), 'youdede-integrity-'));
  context.after(() => rmSync(repository, { recursive: true, force: true }));
  const relative = path.relative(ROOT, source.directory);
  const copiedDirectory = path.join(repository, relative);
  cpSync(source.directory, copiedDirectory, { recursive: true });
  const copied = {
    ...source,
    root: repository,
    directory: copiedDirectory,
    manifestPath: path.join(copiedDirectory, 'artifact.json'),
    adapters: Object.fromEntries(Object.entries(source.adapters).map(([target, adapter]) => [target, {
      path: path.join(copiedDirectory, 'adapters', path.basename(adapter.path)),
      data: adapter.data
    }]))
  };

  writeFileSync(path.join(copiedDirectory, 'SKILL.md'), 'tampered\n');
  writeFileSync(path.join(copiedDirectory, 'unexpected.txt'), 'unexpected\n');
  rmSync(path.join(copiedDirectory, 'agents', 'openai.yaml'));
  const statuses = verifyArtifactAttestation(copied, expected).map(({ status }) => status).sort();
  assert.deepEqual(statuses, ['missing', 'modified', 'unexpected']);
});
