#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Turns the Unreleased changelog into the next version, so nobody picks or types a version by hand.
// The bump comes from the Conventional Commit subjects since the last version change: a breaking
// change is major (minor while the version is 0.x), a feat is minor, anything else is a patch.
// It rewrites package.json and package-lock.json through `npm version`, then CITATION.cff, the
// changelog heading, and the generated marketplace manifests. It commits and tags nothing: the
// result goes through a pull request, and the signed tag follows the merge.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './lib/catalog.mjs';
import { parseChangelog } from './validate-changelog.mjs';

export function nextVersion(current, messages) {
  const [major, minor, patch] = current.split('.').map(Number);
  const breaking = messages.some((message) => /^[a-z]+(?:\([^)]*\))?!:/.test(message) || /^BREAKING[ -]CHANGE:/m.test(message));
  if (breaking && major > 0) return `${major + 1}.0.0`;
  if (breaking || messages.some((message) => /^feat(?:\([^)]*\))?:/.test(message))) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function releaseChangelog(text, version, date) {
  const unreleased = parseChangelog(text).find((section) => section.unreleased);
  if (!unreleased || unreleased.entries === 0) throw new Error('CHANGELOG.md has no Unreleased entries to release');
  return text.replace(/^## Unreleased[ \t]*$/m, `## ${version} (${date})`);
}

function main() {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('the working tree must be clean');
  const { version: current } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const base = git('log', '-1', '--format=%H', '-G"version":', '--', 'package.json');
  const messages = git('log', '--format=%B%x00', `${base}..HEAD`).split('\0').map((message) => message.trim()).filter(Boolean);
  if (messages.length === 0) throw new Error(`nothing has changed since ${current}`);
  const version = nextVersion(current, messages);
  const changelogFile = path.join(ROOT, 'CHANGELOG.md');
  const changelog = releaseChangelog(readFileSync(changelogFile, 'utf8'), version, new Date().toISOString().slice(0, 10));

  execFileSync('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts'], { cwd: ROOT, stdio: 'ignore' });
  writeFileSync(changelogFile, changelog);
  const citationFile = path.join(ROOT, 'CITATION.cff');
  writeFileSync(citationFile, readFileSync(citationFile, 'utf8').replace(/^version: .*$/m, `version: ${version}`));
  for (const script of ['marketplaces', 'integrity']) execFileSync('npm', ['run', '--silent', script], { cwd: ROOT, stdio: 'ignore' });
  process.stdout.write(`${current} -> ${version}. Open a pull request with these changes; after the merge, tag v${version} with \`git tag -s\`.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
