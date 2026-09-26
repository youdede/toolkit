// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

import test from 'node:test';
import assert from 'node:assert/strict';
import { collectContractProblems, payloadProblems } from '../scripts/validate-output-contracts.mjs';

const CONTRACT = 'Return every one of these headings in your reply, in this order, on every path: `## Findings`, `## Evidence gaps`, `## Recommendation`.';
const check = (body, evaluation = null) => payloadProblems({
  manifest: { id: 'skill/test/example' },
  evaluation,
  file: 'SKILL.md',
  text: `# Example\n\n## Output contract\n\n${CONTRACT}\n\n${body}\n`
});

test('the committed catalog has no output-contract contradiction', () => {
  assert.deepEqual(collectContractProblems(), []);
});

test('a payload without an output contract is not checked', () => {
  assert.deepEqual(payloadProblems({ manifest: { id: 'x' }, evaluation: null, file: 'a.md', text: '# Plain\n\nNo contract here.\n' }), []);
});

test('an agreeing payload reports nothing', () => {
  assert.deepEqual(check('## Validation\n\nWrite `## Findings`, `## Evidence gaps`, and `## Recommendation`.'), []);
});

test('a heading demanded elsewhere must appear in the contract', () => {
  const problems = check('## Validation\n\nAlso write `## Release impact`.');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'## Release impact' is required outside the output contract/);
});

test('a conditional mention with a stated fallback is not a contradiction', () => {
  assert.deepEqual(
    check('Record the refusal in `## Scope reviewed` when this contract names that heading; otherwise in the first section it names.'),
    []
  );
});

test('a numbered list must match the contract order', () => {
  const problems = check('## Output\n\nReturn exactly these headings in order:\n\n1. `## Evidence gaps`\n2. `## Findings`\n3. `## Recommendation`');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /the numbered output list orders headings as/);
});

test('a matching numbered list reports nothing', () => {
  assert.deepEqual(
    check('## Output\n\n1. `## Findings`\n2. `## Evidence gaps`\n3. `## Recommendation`'),
    []
  );
});

test('a prose list must not reverse the contract order', () => {
  const problems = check('## Output schema\n\nThen provide `Recommendation`, `Evidence gaps`, and `Findings`.');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /the prose orders/);
});

test('an instruction naming a findings section requires one', () => {
  const text = `# Example\n\n## Output contract\n\nReturn every one of these headings in your reply, in this order, on every path: \`## Evidence\`, \`## Next action\`.\n\nRecord that refusal in the findings section this contract names.\n`;
  const problems = payloadProblems({ manifest: { id: 'skill/test/example' }, evaluation: null, file: 'SKILL.md', text });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /names a findings section that the contract does not declare/);
});

test('a behavioral case may not require a section the contract omits', () => {
  const evaluation = { cases: [{ id: 'positive-one', expected: { requiredSections: ['Findings', 'Rollout review'] } }] };
  const problems = check('## Validation\n\nNothing further.', evaluation);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /case 'positive-one' requires section 'Rollout review'/);
});

test('a repeated heading in the contract is reported', () => {
  const text = '# Example\n\n## Output contract\n\nReturn every one of these headings in your reply, in this order, on every path: `## Findings`, `## Findings`.\n';
  const problems = payloadProblems({ manifest: { id: 'skill/test/example' }, evaluation: null, file: 'SKILL.md', text });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /repeats ## Findings/);
});

test('a contract naming two uncertainty sections is reported', () => {
  const text = '# Example\n\n## Output contract\n\nReturn every one of these headings in your reply, in this order, on every path: `## Findings`, `## Residual uncertainty`, `## Remaining uncertainty`.\n';
  const problems = payloadProblems({ manifest: { id: 'subagent/test/example' }, evaluation: null, file: 'a.md', text });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /names more than one uncertainty section/);
});

test('a subagent contract may not reuse a heading of its own brief', () => {
  const text = '# Example\n\n## Scope\n\nRequire changed paths.\n\n## Output contract\n\nReturn every one of these headings in your reply, in this order, on every path: `## Findings`, `## Scope`.\n';
  const problems = payloadProblems({ manifest: { id: 'subagent/test/example', kind: 'subagent' }, evaluation: null, file: 'a.md', text });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'## Scope' is also a heading of the brief itself/);
});
