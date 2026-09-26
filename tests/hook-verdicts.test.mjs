import test from 'node:test';
import assert from 'node:assert/strict';

import { compare, computeVerdicts, readSnapshot } from '../scripts/record-hook-verdicts.mjs';

// Anti-regression rule 1: every hook verdict in quality/hook-verdicts.json is recomputed. A verdict
// that differs from the snapshot fails unless the entry carries a `change` with the new verdict,
// its reason, and the finding it closes. See docs/deterministic-components.md.
test('hook verdicts match the recorded snapshot', { timeout: 10 * 60 * 1000 }, async () => {
  const document = readSnapshot();
  const verdicts = await computeVerdicts(document);
  let problems = compare(document, verdicts);
  // Hooks that ask Git fail closed when it exceeds their time budget, which a loaded full check can
  // cause. Mismatched entries are rerun once, one at a time; a real difference fails both runs.
  const retry = problems.map((problem) => /^#(\d+) /.exec(problem)?.[1]).filter(Boolean).map(Number);
  if (retry.length) {
    const again = await computeVerdicts({ ...document, entries: retry.map((index) => document.entries[index]) }, { concurrency: 1 });
    retry.forEach((index, position) => { verdicts.results[index] = again.results[position]; });
    problems = compare(document, verdicts);
  }
  assert.deepEqual(problems, [], `${problems.length} hook verdict problems:\n${problems.slice(0, 50).join('\n')}`);
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
