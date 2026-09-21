// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../scripts/lib/catalog.mjs';
import { buildCatalogDocs, KINDS } from '../scripts/generate-catalog-docs.mjs';

const catalog = JSON.parse(readFileSync(path.join(ROOT, 'catalog', 'artifacts.json'), 'utf8'));
const artifacts = catalog.artifacts ?? catalog;
const pages = buildCatalogDocs();

test('the committed catalog pages match the catalog', () => {
  for (const [name, content] of pages) {
    const file = path.join(ROOT, 'docs', 'catalog', name);
    assert.equal(readFileSync(file, 'utf8'), content, `${name} is stale; run npm run catalog:docs`);
  }
});

test('every artifact appears on the page for its kind', () => {
  const of = Object.fromEntries(KINDS.map(({ kind, file }) => [kind, pages.get(file)]));
  const missing = artifacts.filter((a) => !of[a.kind]?.includes(`\`${a.slug}\``));
  assert.deepEqual(missing.map((a) => a.id), [], 'these artifacts are listed nowhere');
});

test('generation is deterministic', () => {
  const again = buildCatalogDocs();
  for (const [name, content] of pages) assert.equal(again.get(name), content);
});

test('a summary containing a pipe cannot break its table row', () => {
  // Every row must keep exactly the four columns the header declares.
  for (const name of ['skills.md', 'hooks.md', 'subagents.md']) {
    for (const line of pages.get(name).split('\n')) {
      if (!line.startsWith('| `')) continue;
      const columns = line.replace(/\\\|/g, '').split('|').length - 2;
      assert.equal(columns, 4, `${name}: row has ${columns} columns: ${line.slice(0, 70)}`);
    }
  }
});

test('a summary is never carried across lines', () => {
  for (const [, content] of pages) {
    for (const line of content.split('\n')) {
      if (line.startsWith('| `')) assert.equal(line.trimEnd().endsWith('|'), true, line.slice(0, 70));
    }
  }
});

test('the index reports the counts the catalog actually holds', () => {
  const index = pages.get('README.md');
  for (const kind of ['skill', 'hook', 'subagent']) {
    const count = artifacts.filter((a) => a.kind === kind).length;
    assert.match(index, new RegExp(`\\| ${count} \\|`), `index does not report ${count} for ${kind}`);
  }
});
