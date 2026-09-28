import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { QUARANTINE, QUARANTINE_CAP, expectationKey, quarantineProblems as gate, readSnapshot, summarize } from '../scripts/record-hook-verdicts.mjs';

// An expectation is a correctness gate: an unmet one fails unless a reviewed quarantine entry holds it.
// These checks read the snapshot only; tests/hook-verdicts.test.mjs recomputes the verdicts.
test('every unmet hook expectation has a reviewed quarantine entry', () => {
  const quarantine = JSON.parse(readFileSync(QUARANTINE, 'utf8'));
  assert.deepEqual(gate(readSnapshot().entries, quarantine), []);
  assert.equal(QUARANTINE_CAP, 0, 'the quarantine is empty on this branch');
});

test('the quarantine gate rejects new, edited, incomplete, stale, and excess entries', () => {
  const quarantineProblems = (entries, quarantine, cap = 7) => gate(entries, quarantine, cap);
  const unmet = { hook: 'h', input: { a: 1 }, expectation: 'should-block per x', exit: 0, ruleId: null, output: null };
  const key = expectationKey(unmet);
  const held = { schemaVersion: 1, entries: { [key]: { hook: 'h', reason: 'r', followUp: 'f' } } };
  assert.deepEqual(quarantineProblems([unmet], held), []);
  assert.match(quarantineProblems([unmet], { schemaVersion: 1, entries: {} }).join(), /unmet, unquarantined/);
  assert.match(quarantineProblems([{ ...unmet, input: { a: 2 } }], held).join(), /unquarantined.*stale/s);
  assert.match(quarantineProblems([{ ...unmet, expectation: 'should-block per y' }], held).join(), /unquarantined/);
  assert.match(quarantineProblems([unmet], { schemaVersion: 1, entries: { [key]: { hook: 'h', reason: ' ', followUp: 'f' } } }).join(), /reason is missing/);
  assert.match(quarantineProblems([unmet], { schemaVersion: 1, entries: { [key]: { hook: 'h', reason: 'r' } } }).join(), /followUp is missing/);
  assert.match(quarantineProblems([unmet], { schemaVersion: 1, entries: { [key]: { hook: 'x', reason: 'r', followUp: 'f' } } }).join(), /hook is not h/);
  assert.match(quarantineProblems([], held).join(), /stale/);
  assert.match(quarantineProblems([unmet], held, 0).join(), /more than 0/);
  // A completed change meets the expectation, so its quarantine entry becomes stale in the same patch.
  const changed = { ...unmet, change: { reason: 'r', finding: 'f', exit: 2, ruleId: 'x', output: null } };
  assert.match(quarantineProblems([changed], held).join(), /stale/);
  assert.deepEqual(quarantineProblems([{ ...unmet, exit: 2 }], { schemaVersion: 1, entries: {} }), []);
});

test('the changed-verdict summary groups changes and requires a class for new blocks', () => {
  const entry = (command, exit, change) => ({ hook: 'h', input: { tool_input: { command } }, exit, ruleId: exit ? 'r' : null, output: null, ...(change ? { change } : {}) });
  const base = { entries: [entry('a', 0), entry('b', 2), entry('c', 0)] };
  const current = { entries: [
    entry('a', 0, { reason: 'x', finding: 'REDO-OWNER s', exit: 2, ruleId: 'u', output: null }),
    entry('b', 2, { reason: 'x', finding: 'y', exit: 0, ruleId: null, output: null }),
    entry('c', 0, { reason: 'x', finding: 'y', exit: 2, ruleId: 'u', output: null }),
    entry('d', 0)
  ] };
  const report = summarize(base, current);
  assert.deepEqual(report.rows.map((row) => [row.index, row.direction, row.kind]), [[0, 'allow to block', 'REDO-OWNER'], [1, 'block to allow', null], [2, 'allow to block', null]]);
  assert.deepEqual(report.problems, ['#2 h: allow to block without a REDO class id']);
  assert.match(report.text, /entry count \+1/);
});
