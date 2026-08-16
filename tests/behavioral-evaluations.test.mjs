import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateBehavioralEvaluations,
  validateEvaluationDocument,
  validateResponseEnvelope
} from '../scripts/validate-evaluations.mjs';
import { ROOT, validateRepository } from '../scripts/lib/catalog.mjs';

test('every public skill and subagent has a complete behavioral contract', () => {
  const result = validateBehavioralEvaluations();
  assert.equal(result.valid, true, result.errors.join('\n'));
  const expectedIds = validateRepository().artifacts
    .filter((record) => record.manifest.kind === 'skill' || record.manifest.kind === 'subagent')
    .map(({ manifest }) => manifest.id)
    .sort();
  assert.ok(expectedIds.length > 0);
  assert.deepEqual(result.records.map(({ manifest }) => manifest.id).sort(), expectedIds);
  assert.equal(result.documents.length, expectedIds.length);
  assert.ok(result.records.some(({ manifest }) => manifest.slug === 'plan-evidence-based-design-research'));
  for (const { document } of result.documents) {
    assert.deepEqual(new Set(document.cases.map((item) => item.type)), new Set(['positive', 'negative', 'malformed', 'boundary']));
    for (const item of document.cases) {
      assert.ok(item.sourceAnchors.length >= 2);
      assert.ok(item.expected.requiredSections.length > 0);
      assert.ok(item.expected.requiredEvidence.length > 0);
      assert.ok(item.expected.forbiddenClaims.length > 0);
      assert.ok(item.expected.forbiddenActions.length > 0);
    }
  }
  for (const { record, document } of result.documents.filter(({ record }) => record.manifest.kind === 'subagent')) {
    const boundary = document.cases.find((item) => item.type === 'boundary' && /ignore|embedded|instruction/i.test(item.prompt));
    assert.ok(boundary, `${record.manifest.id} needs an evidence-injection boundary case`);
    assert.ok(
      boundary.expected.requiredEvidence.some((item) => /untrusted evidence/i.test(item)),
      `${record.manifest.id} must surface the evidence trust boundary`
    );
  }
});

test('behavioral contracts reject unanchored and shallow declarations', () => {
  const result = validateBehavioralEvaluations();
  const target = result.documents.find(({ record }) => record.manifest.slug === 'web-performance-reviewer');
  const malformed = structuredClone(target.document);
  malformed.cases[0].sourceAnchors[0] = 'a phrase that is not in the reviewer prompt';
  malformed.cases[0].expected.requiredEvidence = [];

  const errors = validateEvaluationDocument(malformed, target.record);
  assert.ok(errors.some((message) => /source anchor is absent/.test(message)));
  assert.ok(errors.some((message) => /requiredEvidence must be a non-empty/.test(message)));

  const missingSchema = structuredClone(target.document);
  delete missingSchema.$schema;
  assert.ok(validateEvaluationDocument(missingSchema, target.record).some((message) => /document must be an object/.test(message)));
});

test('behavioral validation honors an alternate repository root', { skip: process.platform === 'win32' }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-evaluation-root-'));
  const linkedRoot = path.join(directory, 'linked-toolkit');
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  symlinkSync(ROOT, linkedRoot, 'dir');

  const result = validateBehavioralEvaluations(linkedRoot);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.ok(result.documents.length > 0);
});

test('saved responses are checked offline for required structure, evidence, and forbidden behavior', () => {
  const result = validateBehavioralEvaluations();
  const artifactId = 'subagent/design/frontend/web-performance-reviewer';
  const envelope = {
    schemaVersion: 1,
    artifactId,
    responses: [
      {
        caseId: 'positive-checkout-image-regression',
        disposition: 'apply',
        text: '## Findings\nThe affected journey is checkout. There is missing runtime proof for the image-carousel change.\n\n## Reviewed surfaces and residual uncertainty\nThe supplied trace was reviewed; field data remains unavailable.'
      }
    ]
  };
  assert.deepEqual(validateResponseEnvelope(envelope, result.documents), { valid: true, errors: [] });

  const forbidden = structuredClone(envelope);
  forbidden.responses[0].text += '\n\nI edited the implementation.';
  const failure = validateResponseEnvelope(forbidden, result.documents);
  assert.equal(failure.valid, false);
  assert.ok(failure.errors.some((message) => /forbidden action/.test(message)));

  const wrongDisposition = structuredClone(envelope);
  wrongDisposition.responses[0].disposition = 'decline';
  const dispositionFailure = validateResponseEnvelope(wrongDisposition, result.documents);
  assert.equal(dispositionFailure.valid, false);
  assert.ok(dispositionFailure.errors.some((message) => /does not match expected 'apply'/.test(message)));
});
