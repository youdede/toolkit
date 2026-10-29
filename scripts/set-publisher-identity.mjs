#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Applies the two publisher decisions that block the first release, each in one pass:
//
//   --holder "<exact legal person or registered company>"   replaces the copyright holder `Youdede`
//   --owner  "<github org or user>"                          moves the repository namespace `youdede`
//
// Neither value can be guessed, so nothing runs without the flag. Use --dry-run first: it prints
// every file it would touch and changes nothing. See docs/publishing-checklist.md for what each
// decision means and what must be true before you make it.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './lib/catalog.mjs';

const HOLDER = 'Youdede';
const OWNER = 'youdede';
// `Youdede` is also the brand (`YoudedeGuardPlugin`, "Youdede MCP server"), so only its holder uses are
// replaced: copyright lines, the NOTICE grant, and quoted author names in manifests, CITATION.cff, and code.
const HOLDER_FORMS = ['2026 HOLDER', 'License by HOLDER,', '"HOLDER"', "'HOLDER'"];

function parse(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') { options.dryRun = true; continue; }
    if (value === '--holder' || value === '--owner') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`);
      options[value.slice(2)] = next;
      index += 1;
      continue;
    }
    throw new Error(`unknown flag '${value}'; use --holder, --owner, or --dry-run`);
  }
  if (!options.holder && !options.owner) {
    throw new Error('nothing to do: pass --holder "<legal name>" and/or --owner "<github org>"');
  }
  return options;
}

// Only files tracked by git are rewritten, so nothing generated or ignored is touched here.
// catalog/ and the integrity manifest are regenerated afterwards instead.
function trackedFiles() {
  return execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.startsWith('catalog/'));
}

function rewrite(files, replacements, dryRun) {
  const touched = [];
  for (const file of files) {
    const absolute = path.join(ROOT, file);
    let text;
    try { text = readFileSync(absolute, 'utf8'); } catch { continue; }
    let next = text;
    for (const [from, to] of replacements) next = next.split(from).join(to);
    if (next === text) continue;
    touched.push(file);
    if (!dryRun) writeFileSync(absolute, next);
  }
  return touched;
}

const options = parse(process.argv.slice(2));
const replacements = [];
if (options.holder) {
  for (const form of HOLDER_FORMS) replacements.push([form.replace('HOLDER', HOLDER), form.replace('HOLDER', options.holder)]);
}
if (options.owner) {
  replacements.push([`github.com/${OWNER}/toolkit`, `github.com/${options.owner}/toolkit`]);
  replacements.push([`@${OWNER}\n`, `@${options.owner}\n`]);
  replacements.push([`@${OWNER} `, `@${options.owner} `]);
}

const touched = rewrite(trackedFiles(), replacements, options.dryRun);

process.stdout.write(`${options.dryRun ? 'Would rewrite' : 'Rewrote'} ${touched.length} file(s).\n`);
for (const file of touched.slice(0, 12)) process.stdout.write(`  ${file}\n`);
if (touched.length > 12) process.stdout.write(`  ... and ${touched.length - 12} more\n`);

if (options.dryRun) {
  process.stdout.write('\nDry run: nothing was written. Re-run without --dry-run to apply.\n');
} else {
  process.stdout.write('\nNow run, in this order:\n');
  process.stdout.write('  npm run catalog\n');
  process.stdout.write('  npm run integrity\n');
  process.stdout.write('  npm run check\n');
  process.stdout.write('\nThe legal gate asserts the holder string, so check:legal proves the rename is complete.\n');
}
