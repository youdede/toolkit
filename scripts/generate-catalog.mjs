#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { publicCatalog, publicPackCatalog, ROOT, validateRepository } from './lib/catalog.mjs';

const check = process.argv.includes('--check');
const { artifacts, results, packs, packResults } = validateRepository();
const invalid = results.flatMap(({ record, errors }) => errors.map((error) => `${record.manifest.id}: ${error}`));
invalid.push(...packResults.flatMap(({ record, errors }) => errors.map((error) => `${record.manifest.id}: ${error}`)));
if (invalid.length) {
  for (const error of invalid) process.stderr.write(`${error}\n`);
  process.exit(1);
}

const outputPath = path.join(ROOT, 'catalog', 'artifacts.json');
let generatedAt = new Date().toISOString();
if (check) {
  try {
    generatedAt = JSON.parse(readFileSync(outputPath, 'utf8')).generatedAt || generatedAt;
  } catch {}
}
const content = `${JSON.stringify(publicCatalog(artifacts, generatedAt), null, 2)}\n`;
const packOutputPath = path.join(ROOT, 'catalog', 'packs.json');
let packGeneratedAt = generatedAt;
if (check) {
  try {
    packGeneratedAt = JSON.parse(readFileSync(packOutputPath, 'utf8')).generatedAt || packGeneratedAt;
  } catch {}
}
const packContent = `${JSON.stringify(publicPackCatalog(packs, artifacts, packGeneratedAt), null, 2)}\n`;

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
