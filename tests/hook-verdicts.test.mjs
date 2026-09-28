import test from 'node:test';
import assert from 'node:assert/strict';

import { ADAPTERS, PROCESS_ONLY, testsProcess } from '../scripts/lib/hook-verdict-inline.mjs';
import { PARITY_STEP, compare, computeVerdicts, listHooks, parityProblems, planCases, readSnapshot } from '../scripts/record-hook-verdicts.mjs';

// Anti-regression rule 1: every hook verdict in quality/hook-verdicts.json is recomputed. A verdict
// that differs from the snapshot fails unless the entry carries a `change` with the new verdict,
// its reason, and the finding it closes. See docs/deterministic-components.md. Most cases run in
// process through the hook's `evaluate` (scripts/lib/hook-verdict-inline.mjs); the parity sample runs
// both ways and must agree. `npm run check:hook-verdicts` runs every case as a hook process.
const indexOf = (problem) => Number(/^#(\d+) /.exec(problem)?.[1] ?? Number.NaN);
test('hook verdicts match the recorded snapshot', { timeout: 10 * 60 * 1000 }, async () => {
  const document = readSnapshot();
  const verdicts = await computeVerdicts(document, { mode: 'mixed', parity: true });
  let problems = compare(document, verdicts);
  // Hooks that ask Git fail closed when it exceeds their time budget, which a loaded full check can
  // cause. Mismatched entries are rerun once as processes, one at a time; a real difference fails both
  // runs.
  const retry = problems.map(indexOf).filter(Number.isInteger);
  if (retry.length) {
    const again = await computeVerdicts({ ...document, entries: retry.map((index) => document.entries[index]) }, { concurrency: 1 });
    retry.forEach((index, position) => { verdicts.results[index] = again.results[position]; });
    problems = compare(document, verdicts);
  }
  // A parity pair that differs is rerun the same way, both ways one at a time.
  let parity = parityProblems(document, verdicts.parity);
  const unequal = new Set(parity.map(indexOf));
  if (unequal.size) {
    const entries = [...unequal].map((index) => document.entries[index]);
    const [inline, real] = [await computeVerdicts({ ...document, entries }, { mode: 'inline', concurrency: 1 }), await computeVerdicts({ ...document, entries }, { concurrency: 1 })];
    const pairs = [...unequal].map((index, position) => ({ index, inline: inline.results[position], process: real.results[position] }));
    parity = parityProblems(document, [...verdicts.parity.filter((pair) => !unequal.has(pair.index)), ...pairs]);
  }
  assert.ok(verdicts.parity.length >= document.entries.length / PARITY_STEP / 2, `only ${verdicts.parity.length} parity pairs`);
  assert.deepEqual([...problems, ...parity], [], `${problems.length + parity.length} hook verdict problems:\n${[...problems, ...parity].slice(0, 50).join('\n')}`);
});

test('every hook runs in process through an adapter or always as a process, and keeps a process case', () => {
  const hooks = [...listHooks().keys()].filter((hook) => hook !== 'test-integrity-paths');
  for (const hook of hooks) assert.ok(Boolean(ADAPTERS[hook]) !== PROCESS_ONLY.includes(hook), `${hook}: add an adapter or list it in PROCESS_ONLY`);
  for (const hook of [...Object.keys(ADAPTERS), ...PROCESS_ONLY]) assert.ok(hooks.includes(hook), `${hook} is not a hook`);
  const { entries } = readSnapshot();
  const plan = planCases(entries, { mode: 'mixed', parity: true });
  for (const hook of hooks) {
    const cases = entries.flatMap((entry, index) => (entry.hook === hook ? [index] : []));
    assert.ok(cases.some((index) => !plan.inline[index]), `${hook} has no case run as a process`);
    if (ADAPTERS[hook] && cases.some((index) => !testsProcess(entries[index]))) assert.ok(cases.some((index) => plan.twice[index]), `${hook} has no parity case`);
  }
  // The cases about the process itself never run in process.
  entries.forEach((entry, index) => { if (testsProcess(entry)) assert.equal(plan.inline[index], false, `#${index}`); });
});

test('hook verdict entries declare change and expectation in the documented shape', () => {
  const { entries } = readSnapshot();
  for (const [index, entry] of entries.entries()) {
    if (entry.expectation !== undefined) assert.match(entry.expectation, /^should-[a-z-]+ per \S/, `#${index}`);
    if (entry.nodeVariants !== undefined) {
      for (const [major, variant] of Object.entries(entry.nodeVariants)) {
        assert.match(major, /^\d+$/, `#${index} nodeVariants key`);
        assert.ok(Object.keys(variant).every((key) => ['exit', 'ruleId', 'output'].includes(key)), `#${index} nodeVariants.${major}`);
      }
    }
    if (entry.change !== undefined) {
      assert.equal(typeof entry.change.reason, 'string', `#${index} change.reason`);
      assert.equal(typeof entry.change.finding, 'string', `#${index} change.finding`);
    }
  }
});
