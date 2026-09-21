#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { publicCatalog, publicPackCatalog, ROOT, validateRepository } from './lib/catalog.mjs';
import { generateMarketplaces } from './generate-marketplaces.mjs';
import { generateCapabilityDocs } from './generate-capability-docs.mjs';

const check = process.argv.includes('--check');
const { artifacts, results, packs, packResults } = validateRepository();
const invalid = results.flatMap(({ record, errors }) => errors.map((error) => `${record.manifest.id}: ${error}`));
invalid.push(...packResults.flatMap(({ record, errors }) => errors.map((error) => `${record.manifest.id}: ${error}`)));
if (invalid.length) {
  for (const error of invalid) process.stderr.write(`${error}\n`);
  process.exit(1);
}

// Catalogs carry no generation timestamp, so identical public inputs produce identical
// output and `--check` compares bytes rather than trusting a value read back from the file.
const outputPath = path.join(ROOT, 'catalog', 'artifacts.json');
const content = `${JSON.stringify(publicCatalog(artifacts), null, 2)}\n`;
const packOutputPath = path.join(ROOT, 'catalog', 'packs.json');
const packContent = `${JSON.stringify(publicPackCatalog(packs, artifacts), null, 2)}\n`;

if (check) {
  let current = '';
  try { current = readFileSync(outputPath, 'utf8'); } catch {}
  if (current !== content) {
    process.stderr.write('catalog/artifacts.json is stale; run npm run catalog.\n');
    process.exit(1);
  }
  let currentPacks = '';
  try { currentPacks = readFileSync(packOutputPath, 'utf8'); } catch {}
  if (currentPacks !== packContent) {
    process.stderr.write('catalog/packs.json is stale; run npm run catalog.\n');
    process.exit(1);
  }
  process.stdout.write('Catalogs are current.\n');
} else {
  const temp = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(temp, content);
  renameSync(temp, outputPath);
  const packTemp = `${packOutputPath}.tmp-${process.pid}`;
  writeFileSync(packTemp, packContent);
  renameSync(packTemp, packOutputPath);
  process.stdout.write(`Generated ${path.relative(ROOT, outputPath)} with ${artifacts.length} artifacts and ${path.relative(ROOT, packOutputPath)} with ${packs.length} packs.\n`);
}

generateMarketplaces({ root: ROOT, check });
generateCapabilityDocs({ root: ROOT, check });
