#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 youdede contributors

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadArtifacts, ROOT } from './lib/catalog.mjs';
import { buildIntegrityManifest } from './lib/integrity.mjs';

const check = process.argv.includes('--check');
const output = path.join(ROOT, 'catalog', 'integrity.json');
const content = `${JSON.stringify(buildIntegrityManifest(loadArtifacts(ROOT)), null, 2)}\n`;

if (check) {
  let current = '';
  try { current = readFileSync(output, 'utf8'); } catch {}
  if (current !== content) {
    process.stderr.write('catalog/integrity.json is stale; run npm run integrity.\n');
    process.exit(1);
  }
  process.stdout.write('Artifact integrity attestations are current.\n');
} else {
  const temporary = `${output}.tmp-${process.pid}`;
  writeFileSync(temporary, content);
  renameSync(temporary, output);
  process.stdout.write(`Generated ${path.relative(ROOT, output)} for ${loadArtifacts(ROOT).length} artifacts.\n`);
}
