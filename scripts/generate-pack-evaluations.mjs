#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from './lib/catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function expectedPackEvaluations(root = ROOT) {
  return loadPacks(root).map(({ directory, manifest }) => {
    const outcomes = manifest.outcomes;
    const cases = [
      {
        id: `${manifest.slug}-complete-evidence`,
        type: 'positive',
        scenario: `Every required ${manifest.name} member contributes declared evidence, every outcome is verified, and the report cites the current ledger entry.`,
        expected: { verdict: 'accept', outcomes }
      },
      {
        id: `${manifest.slug}-missing-evidence`,
        type: 'missing-evidence',
        scenario: `One required ${manifest.name} member has no evidence hash even though its mapped outcome is marked verified.`,
        expected: { verdict: 'refuse', outcomes }
      },
      {
        id: `${manifest.slug}-ledger-mismatch`,
        type: 'ledger-mismatch',
        scenario: `The ${manifest.name} report cites a ledger entry hash that does not match the checkpoint carrying its claims.`,
        expected: { verdict: 'refuse', outcomes }
      },
      {
        id: `${manifest.slug}-unsupported-coordinate`,
        type: 'unsupported-coordinate',
        scenario: `The requested ${manifest.name} target and scope cannot install every required member at one common coordinate.`,
        expected: { verdict: 'refuse', outcomes }
      }
    ];
    const document = { $schema: '../../../schema/pack-evaluation.schema.json', schemaVersion: 1, packId: manifest.id, cases };
    return { file: path.join(directory, 'evaluations/behavioral.json'), content: Buffer.from(`${JSON.stringify(document, null, 2)}\n`) };
  });
}

export function generatePackEvaluations({ root = ROOT, check = false } = {}) {
  const stale = [];
  for (const { file, content } of expectedPackEvaluations(root)) {
    if (existsSync(file) && readFileSync(file).equals(content)) continue;
    stale.push(path.relative(root, file));
    if (!check) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); }
  }
  if (check && stale.length) throw new Error(`pack behavioral evaluations are stale: ${stale.join(', ')}`);
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const stale = generatePackEvaluations({ check: process.argv.includes('--check') });
    process.stdout.write(`${stale.length ? `Updated ${stale.length}` : 'Verified'} pack behavioral evaluation${stale.length === 1 ? '' : 's'}.\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
