#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks } from './lib/catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = new Set(['positive', 'missing-evidence', 'ledger-mismatch', 'unsupported-coordinate']);

function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }

export function validatePackEvaluation(document, pack) {
  const errors = [];
  if (!plain(document) || Object.keys(document).sort().join() !== '$schema,cases,packId,schemaVersion') return ['document must contain only $schema, schemaVersion, packId, and cases'];
  if (document.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (document.packId !== pack.id) errors.push('packId must match its pack');
  if (!Array.isArray(document.cases)) return [...errors, 'cases must be an array'];
  const ids = new Set();
  const types = new Set();
  for (const [index, item] of document.cases.entries()) {
    const prefix = `cases[${index}]`;
    if (!plain(item) || Object.keys(item).sort().join() !== 'expected,id,scenario,type') { errors.push(`${prefix} has unexpected structure`); continue; }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id || '') || ids.has(item.id)) errors.push(`${prefix}.id must be unique lowercase hyphen-case`);
    ids.add(item.id);
    if (!TYPES.has(item.type) || types.has(item.type)) errors.push(`${prefix}.type must be one unique required scenario type`);
    types.add(item.type);
    if (typeof item.scenario !== 'string' || item.scenario.length < 20 || item.scenario.length > 500) errors.push(`${prefix}.scenario must contain 20-500 characters`);
    const expectedVerdict = item.type === 'positive' ? 'accept' : 'refuse';
    if (!plain(item.expected) || item.expected.verdict !== expectedVerdict) errors.push(`${prefix}.expected.verdict must be ${expectedVerdict}`);
    const outcomes = item.expected?.outcomes;
    if (!Array.isArray(outcomes) || outcomes.length !== pack.outcomes.length || !pack.outcomes.every((outcome) => outcomes.includes(outcome))) errors.push(`${prefix}.expected.outcomes must name every pack outcome`);
  }
  for (const type of TYPES) if (!types.has(type)) errors.push(`cases must include ${type}`);
  return errors;
}

export function validatePackEvaluations(root = ROOT) {
  const failures = [];
  for (const { directory, manifest } of loadPacks(root)) {
    const file = path.join(directory, 'evaluations/behavioral.json');
    if (!existsSync(file)) { failures.push(`${manifest.id}: evaluation is missing`); continue; }
    let document;
    try { document = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { failures.push(`${manifest.id}: ${error.message}`); continue; }
    if (path.resolve(path.dirname(file), document.$schema || '') !== path.join(root, 'schema/pack-evaluation.schema.json')) failures.push(`${manifest.id}: $schema must resolve to schema/pack-evaluation.schema.json`);
    for (const error of validatePackEvaluation(document, manifest)) failures.push(`${manifest.id}: ${error}`);
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = validatePackEvaluations();
  if (failures.length) { process.stderr.write(`${failures.join('\n')}\n`); process.exitCode = 1; }
  else process.stdout.write(`${loadPacks().length} pack behavioral evaluations valid.\n`);
}
