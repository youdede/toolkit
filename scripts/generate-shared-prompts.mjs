#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Copies each module of scripts/lib/shared-prompt/ into every prompt payload that carries the
// module's heading, so one finding format, one severity scale, one confidence scale, and one rule
// for reviewing a change or a partition hold across the catalog while an installed payload stays
// one self-contained file. With --check it only reports stale copies. A subagent whose output
// contract names `## Findings` must carry `## Finding record`: a specialist that reports findings
// in a private format cannot be merged with the others. `## Review mode` is opt-in, because some
// specialists only make sense on a change.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArtifacts, ROOT } from './lib/catalog.mjs';
import { extractOutputContract } from './lib/output-contract.mjs';

const MODULE_DIRECTORY = path.join('scripts', 'lib', 'shared-prompt');
const FINDING_RECORD = '## Finding record';

// heading -> block. Each module starts with the heading it owns.
export function loadSharedSections(root = ROOT) {
  const directory = path.join(root, MODULE_DIRECTORY);
  const sections = new Map();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.md')).sort()) {
    const block = readFileSync(path.join(directory, file), 'utf8');
    const heading = block.split('\n', 1)[0];
    if (!/^## \S/.test(heading)) throw new Error(`${file}: a shared prompt module must start with its '## ' heading`);
    if (sections.has(heading)) throw new Error(`${file}: '${heading}' is already owned by another module`);
    sections.set(heading, block);
  }
  return sections;
}

// Returns the payload with its section replaced by the block, or null when it has no such section.
export function renderSharedSection(text, block) {
  const heading = block.split('\n', 1)[0];
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) return null;
  if (lines.indexOf(heading, start + 1) !== -1) throw new Error(`more than one '${heading}' section`);
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  return [...lines.slice(0, start), ...block.trimEnd().split('\n'), '', ...lines.slice(end)].join('\n');
}

// Returns { stale, missing, carriers }: repository-relative paths; carriers maps each heading to
// the payloads that carry it. With write, stale copies are refreshed.
export function syncSharedSections({ root = ROOT, write = false } = {}) {
  const sections = loadSharedSections(root);
  const stale = [];
  const missing = [];
  const carriers = new Map([...sections.keys()].map((heading) => [heading, []]));
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
        let rendered = text;
        for (const [heading, block] of sections) {
          const next = renderSharedSection(rendered, block);
          if (next === null) continue;
          carriers.get(heading).push(relative);
          rendered = next;
        }
        const reportsFindings = extractOutputContract(text).headings.includes('## Findings');
        if (manifest.kind === 'subagent' && reportsFindings && !carriers.get(FINDING_RECORD).includes(relative)) missing.push(relative);
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
  const { stale, missing, carriers } = syncSharedSections({ write: !check });
  for (const file of missing) process.stderr.write(`${file}: reports findings but has no '${FINDING_RECORD}' section\n`);
  if (check) for (const file of stale) process.stderr.write(`${file}: stale shared prompt section; run npm run shared-prompts\n`);
  if (missing.length > 0 || (check && stale.length > 0)) process.exit(1);
  const total = [...carriers.values()].reduce((sum, files) => sum + files.length, 0);
  process.stdout.write(`${check ? 'Verified' : `Refreshed ${stale.length} payloads;`} ${total} shared prompt sections (${[...carriers].map(([heading, files]) => `${heading.slice(3)}: ${files.length}`).join(', ')}).\n`);
}
