import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compactSnapshot, expandSnapshot, serializeCompactSnapshot } from '../scripts/lib/hook-verdict-format.mjs';
import { SNAPSHOT } from '../scripts/record-hook-verdicts.mjs';

// quality/hook-verdicts.json stores each case once (schema 2) and expands to the flat rows in memory.
const effective = (entry) => (entry.change && 'exit' in entry.change ? entry.change : entry);
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('schema 2 stores a case once and expands to the same rows', () => {
  const flat = { schemaVersion: 1, fixtures: {}, entries: [
    { hook: 'a', input: bash('npm test'), fixture: 'daily', source: 'daily', exit: 0, ruleId: null, output: null },
    { hook: 'b', input: bash('npm test'), fixture: 'daily', source: 'daily', expectation: 'should-allow per daily', exit: 0, ruleId: null, output: null },
    { hook: 'a', raw: 'not json', source: 'other', exit: 2, ruleId: 'r', output: null, change: { reason: 'x', finding: 'F', exit: 0, ruleId: null, output: null } },
    { hook: 'b', raw: 'not json', source: 'third', exit: 0, ruleId: null, output: null, nodeVariants: { 22: { exit: 2 } } },
    { hook: 'a', input: bash('ls'), source: 'new case, not recorded yet' }
  ] };
  const compact = compactSnapshot(flat);
  assert.equal(compact.schemaVersion, 2);
  assert.equal(compact.cases.length, 3);
  assert.equal(compact.cases[0].source, 'daily');
  assert.deepEqual(Object.keys(compact.cases[0].results), ['a', 'b']);
  assert.equal(compact.cases[1].source, undefined);
  assert.deepEqual(expandSnapshot(compact).entries, flat.entries);
  assert.deepEqual(expandSnapshot(JSON.parse(serializeCompactSnapshot(flat))).entries, flat.entries);
});

test('duplicate rows of a hook and case merge, and conflicting ones are refused', () => {
  const row = { hook: 'a', input: bash('ls'), source: 'one', exit: 2, ruleId: 'r', output: null };
  const changed = { ...row, source: 'two', exit: 0, ruleId: null, change: { reason: 'x', finding: 'F', exit: 2, ruleId: 'r', output: null } };
  const [merged] = expandSnapshot(compactSnapshot({ schemaVersion: 1, fixtures: {}, entries: [row, changed, { ...row }] })).entries;
  assert.deepEqual(merged, { ...changed, source: 'one; two' });
  assert.throws(() => compactSnapshot({ schemaVersion: 1, fixtures: {}, entries: [row, { ...row, exit: 0 }] }), /conflicting effective verdicts/);
  assert.throws(() => compactSnapshot({ schemaVersion: 1, fixtures: {}, entries: [row, { ...row, expectation: 'should-allow per x' }, { ...row, expectation: 'should-block per x' }] }), /conflicting expectation/);
});

test('the stored corpus is schema 2 and is written back byte for byte', () => {
  const text = readFileSync(SNAPSHOT, 'utf8');
  const stored = JSON.parse(text);
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.entries, undefined);
  assert.equal(serializeCompactSnapshot(expandSnapshot(stored)), text);
});
