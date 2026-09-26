import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareJsonSchemas,
  MAX_FILE_BYTES
} from '../artifacts/skills/data/schemas/review-schema-evolution/scripts/compare-json-schema.mjs';

const helper = path.resolve('artifacts/skills/data/schemas/review-schema-evolution/scripts/compare-json-schema.mjs');

test('schema helper reports stable structural signals without a compatibility verdict', () => {
  const before = {
    type: 'object',
    required: ['id', 'status'],
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['active', 'paused'] },
      legacy: { type: 'number' }
    }
  };
  const after = {
    type: 'object',
    required: ['id', 'email'],
    additionalProperties: false,
    properties: {
      id: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['active', 'archived'] },
      email: { type: 'string', minLength: 3 }
    }
  };

  const result = compareJsonSchemas(before, after);
  assert.equal(result.verdict, 'not-assessed');
  assert.deepEqual(result.signals.map((signal) => signal.ruleId), [
    'ADDITIONAL_PROPERTIES_CHANGED',
    'PROPERTY_ADDED',
    'TYPE_CHANGED',
    'PROPERTY_REMOVED',
    'ENUM_VALUES_ADDED',
    'ENUM_VALUES_REMOVED',
    'REQUIRED_ADDED',
    'REQUIRED_REMOVED'
  ]);
  assert.equal(result.summary.signalCount, 8);
});

test('schema helper emits no signals for semantically reordered object keys and type arrays', () => {
  const before = { type: ['string', 'null'], properties: { id: { type: 'string' } } };
  const after = { properties: { id: { type: 'string' } }, type: ['null', 'string'] };
  assert.deepEqual(compareJsonSchemas(before, after).signals, []);
});

test('schema helper represents an added constraint without crashing on an undeclared prior value', () => {
  const result = compareJsonSchemas(
    { type: 'string' },
    { type: 'string', minLength: 3 }
  );
  assert.deepEqual(result.signals, [{
    ruleId: 'CONSTRAINT_CHANGED',
    pointer: '/minLength',
    keyword: 'minLength',
    before: 'not-declared',
    after: '3'
  }]);
});

test('schema helper keeps unresolved references explicit and refuses malformed JSON', () => {
  const result = compareJsonSchemas({ $ref: 'https://example.invalid/old.json' }, { $ref: '#/$defs/current' });
  assert.equal(result.summary.unresolvedReferenceCount, 2);
  assert.equal(result.signals[0].ruleId, 'REFERENCE_CHANGED');

  const directory = mkdtempSync(path.join(os.tmpdir(), 'schema-evolution-'));
  try {
    const before = path.join(directory, 'before.json');
    const after = path.join(directory, 'after.json');
    writeFileSync(before, '{invalid');
    writeFileSync(after, '{}');
    const execution = spawnSync(process.execPath, [helper, '--before', before, '--after', after], { encoding: 'utf8' });
    assert.equal(execution.status, 2);
    assert.match(execution.stderr, /invalid JSON/);
    assert.equal(execution.stdout, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema helper accepts the file-size boundary and rejects oversized or symbolic-link input', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'schema-evolution-boundary-'));
  try {
    const before = path.join(directory, 'before.json');
    const after = path.join(directory, 'after.json');
    const padding = MAX_FILE_BYTES - '{"description":""}'.length;
    writeFileSync(before, `{"description":"${'x'.repeat(padding)}"}`);
    writeFileSync(after, '{}');
    const boundary = spawnSync(process.execPath, [helper, '--before', before, '--after', after], { encoding: 'utf8' });
    assert.equal(boundary.status, 0, boundary.stderr);

    writeFileSync(before, `{"description":"${'x'.repeat(padding + 1)}"}`);
    const oversized = spawnSync(process.execPath, [helper, '--before', before, '--after', after], { encoding: 'utf8' });
    assert.equal(oversized.status, 2);
    assert.match(oversized.stderr, /exceeds/);

    if (process.platform === 'win32') {
      t.diagnostic('symbolic-link assertion skipped on Windows');
      return;
    }
    const link = path.join(directory, 'linked.json');
    const linked = spawnSync('ln', ['-s', after, link], { encoding: 'utf8' });
    assert.equal(linked.status, 0, linked.stderr);
    const symlink = spawnSync(process.execPath, [helper, '--before', link, '--after', after], { encoding: 'utf8' });
    assert.equal(symlink.status, 2);
    assert.match(symlink.stderr, /symbolic-link/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema helper rejects non-schema roots and excessive traversal depth', () => {
  assert.throws(() => compareJsonSchemas([], {}), /root must be/);
  let deep = {};
  for (let index = 0; index < 66; index += 1) deep = { items: deep };
  assert.throws(() => compareJsonSchemas(deep, deep), /maximum depth/);
});

test('schema helper reports keywords outside its dedicated rules instead of staying silent', () => {
  const before = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', unevaluatedProperties: true, dependencies: { a: ['b'] }, additionalItems: true, description: 'old' };
  const after = { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', unevaluatedProperties: false, additionalItems: false, description: 'new' };
  const result = compareJsonSchemas(before, after);
  const changed = result.signals.filter((s) => s.ruleId === 'SCHEMA_KEYWORD_CHANGED').map((s) => s.keyword).sort();
  assert.deepEqual(changed, ['$schema', 'additionalItems', 'dependencies', 'unevaluatedProperties']);
  assert.ok(result.limitations.some((line) => /annotation/i.test(line)));
});
