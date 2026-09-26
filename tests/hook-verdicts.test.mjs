import test from 'node:test';
import assert from 'node:assert/strict';

import { compare, computeVerdicts, readSnapshot } from '../scripts/record-hook-verdicts.mjs';

// Anti-regression rule 1: every hook verdict in quality/hook-verdicts.json is recomputed. A verdict
// that differs from the snapshot fails unless the entry carries a `change` with the new verdict,
// its reason, and the finding it closes. See docs/deterministic-components.md.
test('hook verdicts match the recorded snapshot', { timeout: 10 * 60 * 1000 }, async () => {
  const document = readSnapshot();
  const problems = compare(document, await computeVerdicts(document));
  assert.deepEqual(problems, [], `${problems.length} hook verdict problems:\n${problems.slice(0, 50).join('\n')}`);
});

test('hook verdict entries declare change and expectation in the documented shape', () => {
  const { entries } = readSnapshot();
  for (const [index, entry] of entries.entries()) {
    if (entry.expectation !== undefined) assert.match(entry.expectation, /^should-[a-z-]+ per \S/, `#${index}`);
    if (entry.change !== undefined) {
      assert.equal(typeof entry.change.reason, 'string', `#${index} change.reason`);
      assert.equal(typeof entry.change.finding, 'string', `#${index} change.finding`);
    }
  }
});
