#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Copies scripts/lib/shared-prompt/finding-record.md into every prompt payload that carries a
// `## Finding record` section, so one finding format, one severity scale, and one confidence scale
// hold across the catalog while an installed payload stays one self-contained file. With --check it
// only reports stale copies. A subagent whose output contract names `## Findings` must carry the
// section: a specialist that reports findings in a private format cannot be merged with the others.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArtifacts, ROOT } from './lib/catalog.mjs';
import { extractOutputContract } from './lib/output-contract.mjs';

const SOURCE = path.join(ROOT, 'scripts', 'lib', 'shared-prompt', 'finding-record.md');
const HEADING = '## Finding record';

// Returns the payload with its section replaced by the block, or null when it has no such section.
export function renderFindingRecord(text, block) {
  const lines = text.split('\n');
  const start = lines.indexOf(HEADING);
  if (start === -1) return null;
  if (lines.indexOf(HEADING, start + 1) !== -1) throw new Error(`more than one '${HEADING}' section`);
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  return [...lines.slice(0, start), ...block.trimEnd().split('\n'), '', ...lines.slice(end)].join('\n');
}

// Returns { stale, missing, carriers }: repository-relative paths. With write, stale copies are refreshed.
export function syncFindingRecords({ root = ROOT, write = false } = {}) {
  const block = readFileSync(path.join(root, path.relative(ROOT, SOURCE)), 'utf8');
  const stale = [];
  const missing = [];
  const carriers = [];
  const seen = new Set();
  for (const { manifest, directory, adapters } of loadArtifacts(root)) {
    for (const adapter of Object.values(adapters ?? {})) {
      for (const entry of adapter.data?.files ?? []) {
        if (!/\.(md|mdc)$/.test(entry.from ?? '')) continue;
        const full = path.resolve(directory, entry.from);
        if (seen.has(full)) continue;
        seen.add(full);
        const text = readFileSync(full, 'utf8');
        const relative = path.relative(root, full);
        const rendered = renderFindingRecord(text, block);
        if (rendered === null) {
          const reportsFindings = extractOutputContract(text).headings.includes('## Findings');
          if (manifest.kind === 'subagent' && reportsFindings) missing.push(relative);
          continue;
        }
        carriers.push(relative);
        if (rendered === text) continue;
        stale.push(relative);
        if (write) writeFileSync(full, rendered);
      }
    }
  }
  return { stale, missing, carriers };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const { stale, missing, carriers } = syncFindingRecords({ write: !check });
  for (const file of missing) process.stderr.write(`${file}: reports findings but has no '${HEADING}' section\n`);
  if (check) for (const file of stale) process.stderr.write(`${file}: stale '${HEADING}' section; run npm run shared-prompts\n`);
  if (missing.length > 0 || (check && stale.length > 0)) process.exit(1);
  process.stdout.write(`${check ? 'Verified' : `Refreshed ${stale.length} of`} ${carriers.length} finding record sections.\n`);
}
