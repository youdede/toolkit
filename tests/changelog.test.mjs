// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../scripts/lib/catalog.mjs';
import { validateChangelog, parseChangelog } from '../scripts/validate-changelog.mjs';

const header = '# Changelog\n\nPreamble.\n\n';
const entry = (version, body = '### Added\n\n- Something.\n') => `## ${version}\n\n${body}\n`;

test('the committed changelog documents the version being released', () => {
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const result = validateChangelog(readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  assert.deepEqual(result.errors, []);
});

test('a release whose version has no changelog section is refused', () => {
  const result = validateChangelog(`${header}${entry('0.1.0')}`, '0.2.0');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /no section for version 0\.2\.0/);
});

test('a changelog section with no entries is refused', () => {
  const result = validateChangelog(`${header}## 0.1.0\n\n### Added\n\n`, '0.1.0');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /lists no entries/);
});

test('a date or label after the version does not change its identity', () => {
  assert.deepEqual(validateChangelog(`${header}${entry('0.1.0 — 2026-08-25')}`, '0.1.0').errors, []);
  assert.deepEqual(validateChangelog(`${header}${entry('v0.1.0')}`, '0.1.0').errors, []);
});

test('versions must descend, and none may repeat', () => {
  const ascending = validateChangelog(`${header}${entry('0.1.0')}${entry('0.2.0')}`, '0.2.0');
  assert.equal(ascending.valid, false);
  assert.match(ascending.errors[0], /must descend/);

  const repeated = validateChangelog(`${header}${entry('0.2.0')}${entry('0.2.0')}`, '0.2.0');
  assert.equal(repeated.valid, false);
  assert.match(repeated.errors[0], /more than once/);
});

test('Unreleased is allowed, but only once and only at the top', () => {
  assert.deepEqual(
    validateChangelog(`${header}## Unreleased\n\nNothing yet.\n\n${entry('0.1.0')}`, '0.1.0').errors,
    []
  );
  const below = validateChangelog(`${header}${entry('0.1.0')}## Unreleased\n\nNothing yet.\n`, '0.1.0');
  assert.equal(below.valid, false);
  assert.match(below.errors[0], /above every released version/);

  const twice = validateChangelog(`${header}## Unreleased\n\n## Unreleased\n\n${entry('0.1.0')}`, '0.1.0');
  assert.equal(twice.valid, false);
  assert.match(twice.errors.join(' '), /more than one Unreleased/);
});

test('a changelog with nothing released is refused', () => {
  const result = validateChangelog(`${header}## Unreleased\n\n- Something.\n`, '0.1.0');
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /declares no released version/);
});

test('an entry is a list item, not a subheading', () => {
  const [section] = parseChangelog('## 0.1.0\n\n### Added\n\n- One.\n- Two.\n');
  assert.equal(section.version, '0.1.0');
  assert.equal(section.entries, 2);
});
