import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

// The migration proof, from stored digests so it needs no Git history (CI checks out one commit).
// They were taken from the schema 1 file at f6d61207 without the format code: ROWS_DIGEST is the
// SHA-256 of the 15,108 rows that no other row duplicates, each in canonical JSON (keys sorted),
// sorted and joined by newlines; DUPLICATES holds, for each of the 11 hook-case keys that had
// several rows (23 rows), the effective verdict they agreed on. MIGRATED is the SHA-256 of the file
// the migration wrote (ada523c9). The proof applies to that file: once a later change records a
// verdict, the file no longer is the migration's output and the test says so.
const ROWS_DIGEST = '996dd33935d90e381ee34e11cc5a2b201750138380947266c87c97521a5b3cb3';
const MIGRATED = '7ce2b7f1092b144b1430bf10b9ce1e6851c9220011b0573fdd533bd4cd75f6ac';
const allow = { exit: 0, ruleId: null, output: null };
const DUPLICATES = {
  '78bdb6a5dfa9104e': allow, d654c1b9b661c6c5: allow, '251b4ceda7368228': { exit: 2, ruleId: 'package-publish-command-uninspectable', output: null },
  '1d49500c927cdd06': allow, efe454dafe22818f: allow, '198a546b63ed6e0b': allow, f5408ead7b074257: allow,
  fc297cc979075af7: { exit: 2, ruleId: 'service-command-uninspectable', output: null }, '43eb5ec68d05668f': allow, '75e5655b48bcbf97': allow,
  '110a59b2afcbff05': allow
};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value));
const keyOf = (entry) => sha256(canonical([entry.hook, entry.raw ?? null, entry.input ?? null, entry.fixture ?? null, entry.via ?? null, entry.env ?? null])).slice(0, 16);
const stored = readFileSync(SNAPSHOT, 'utf8');
test('the expansion equals the schema 1 rows it was migrated from', { skip: sha256(stored) !== MIGRATED && 'the snapshot changed after the migration (ada523c9)' }, () => {
  const entries = expandSnapshot(JSON.parse(stored)).entries;
  const single = entries.filter((entry) => !(keyOf(entry) in DUPLICATES));
  assert.equal(single.length, 15108);
  assert.equal(sha256(single.map(canonical).sort().join('\n')), ROWS_DIGEST);
  const merged = entries.filter((entry) => keyOf(entry) in DUPLICATES);
  assert.deepEqual(merged.map(keyOf).sort(), Object.keys(DUPLICATES).sort(), 'one row per duplicated hook and case');
  for (const entry of merged) {
    const { exit, ruleId, output } = effective(entry);
    assert.deepEqual({ exit, ruleId, output }, DUPLICATES[keyOf(entry)], keyOf(entry));
  }
});
