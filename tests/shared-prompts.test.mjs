// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFindingRecord, syncFindingRecords } from '../scripts/generate-shared-prompts.mjs';
import { loadArtifacts } from '../scripts/lib/catalog.mjs';

const BLOCK = '## Finding record\n\nCurrent text.\n';

test('a stale section is replaced and the result is stable', () => {
  const stale = '# Brief\n\n## Finding record\n\nOld text.\n\nMore old text.\n\n## Refusals\n\n- None.\n';
  const rendered = renderFindingRecord(stale, BLOCK);
  assert.equal(rendered, '# Brief\n\n## Finding record\n\nCurrent text.\n\n## Refusals\n\n- None.\n');
  assert.equal(renderFindingRecord(rendered, BLOCK), rendered);
});

test('a section at the end of the payload keeps one trailing newline', () => {
  assert.equal(renderFindingRecord('# Brief\n\n## Finding record\n', BLOCK), '# Brief\n\n## Finding record\n\nCurrent text.\n');
});

test('a payload without the section is left alone and a duplicate section is refused', () => {
  assert.equal(renderFindingRecord('# Brief\n\n## Refusals\n', BLOCK), null);
  assert.throws(() => renderFindingRecord('## Finding record\n\n## Finding record\n', BLOCK), /more than one/);
});

test('every committed subagent payload carries the current finding record', () => {
  const { stale, missing, carriers } = syncFindingRecords();
  assert.deepEqual(stale, []);
  assert.deepEqual(missing, []);
  const subagentPayloads = loadArtifacts()
    .filter(({ manifest }) => manifest.kind === 'subagent')
    .reduce((total, { adapters }) => total + Object.keys(adapters).length, 0);
  assert.equal(carriers.filter((file) => file.startsWith('artifacts/subagents/')).length, subagentPayloads);
});
