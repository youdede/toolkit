#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// The release workflow already refuses a tag that does not match package.json. This closes the
// other half of the chain: package.json must match a populated CHANGELOG section. Tag, version and
// changelog then move together or the build fails, and a release cannot ship describing itself as
// "Unreleased". Like every other gate here it generates nothing; it refuses.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './lib/catalog.mjs';

const SECTION = /^##\s+(.+?)\s*$/gm;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const UNRELEASED = /^unreleased$/i;

// "## 0.1.0 — 2026-08-25" and "## 0.1.0" both name version 0.1.0. Anything after the version is a
// date or a label, never part of the identity.
function versionOf(heading) {
  const first = heading.split(/\s+/)[0].replace(/^v/, '');
  return SEMVER.test(first) ? first : null;
}

function compare(left, right) {
  const a = left.split('-')[0].split('.').map(Number);
  const b = right.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function parseChangelog(text) {
  const headings = [...text.matchAll(SECTION)];
  return headings.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    return {
      heading: match[1],
      version: versionOf(match[1]),
      unreleased: UNRELEASED.test(match[1]),
      // An entry is a list item; "### Added" alone is a heading with nothing under it.
      entries: text.slice(start, end).split('\n').filter((line) => /^\s*[-*]\s+\S/.test(line)).length
    };
  });
}

export function validateChangelog(text, version) {
  const errors = [];
  const sections = parseChangelog(text);
  const released = sections.filter((s) => s.version);

  const current = released.find((s) => s.version === version);
  if (!current) {
    errors.push(`CHANGELOG.md has no section for version ${version}; add "## ${version}" before releasing it`);
  } else if (current.entries === 0) {
    errors.push(`CHANGELOG.md section for ${version} lists no entries`);
  }

  const duplicates = released.map((s) => s.version).filter((v, i, all) => all.indexOf(v) !== i);
  for (const duplicate of [...new Set(duplicates)]) {
    errors.push(`CHANGELOG.md declares version ${duplicate} more than once`);
  }

  for (let i = 1; i < released.length; i += 1) {
    if (compare(released[i - 1].version, released[i].version) <= 0) {
      errors.push(`CHANGELOG.md lists ${released[i - 1].version} above ${released[i].version}; versions must descend`);
    }
  }

  const unreleased = sections.filter((s) => s.unreleased);
  if (unreleased.length > 1) errors.push('CHANGELOG.md declares more than one Unreleased section');
  if (unreleased.length === 1 && sections.indexOf(unreleased[0]) !== 0) {
    errors.push('CHANGELOG.md must place Unreleased above every released version');
  }
  if (released.length === 0) errors.push('CHANGELOG.md declares no released version');

  return { valid: errors.length === 0, errors, sections };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const result = validateChangelog(readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  if (!result.valid) {
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    process.exit(1);
  }
  const released = result.sections.filter((s) => s.version).length;
  process.stdout.write(`✓ CHANGELOG.md documents version ${version} across ${released} released sections\n`);
}
