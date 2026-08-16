#!/usr/bin/env node

import { validateRepository } from './lib/catalog.mjs';

const { artifacts, results, packs, packResults } = validateRepository();
let failures = 0;
for (const { record, errors } of results) {
  if (errors.length === 0) {
    process.stdout.write(`✓ ${record.manifest.id}\n`);
    continue;
  }
  failures += errors.length;
  process.stderr.write(`✗ ${record.manifest.id || record.manifestPath}\n`);
  for (const error of errors) process.stderr.write(`  - ${error}\n`);
}
for (const { record, errors } of packResults) {
  if (errors.length === 0) {
    process.stdout.write(`✓ ${record.manifest.id}\n`);
    continue;
  }
  failures += errors.length;
  process.stderr.write(`✗ ${record.manifest.id || record.manifestPath}\n`);
  for (const error of errors) process.stderr.write(`  - ${error}\n`);
}

if (artifacts.length === 0) {
  process.stderr.write('No artifacts found.\n');
  process.exitCode = 1;
} else if (failures > 0) {
  process.stderr.write(`\n${failures} validation error(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\n${artifacts.length} artifacts and ${packs.length} packs valid.\n`);
}
