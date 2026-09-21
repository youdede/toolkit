#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePack, ROOT } from './lib/catalog.mjs';

const MAX_REPORT_BYTES = 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const EVIDENCE_SCHEMA_ID = 'https://youdede.dev/schemas/pack-evidence-v1.json';

function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).sort().join() === [...keys].sort().join();
}

export function readPackEvidenceReport(file) {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile() || statSync(file).size > MAX_REPORT_BYTES) throw new Error('report must be a regular non-symlink JSON file no larger than 1 MiB');
  return JSON.parse(readFileSync(realpathSync(file), 'utf8'));
}

export function verifyPackEvidence(pack, report) {
  const failures = [];
  if (!plain(report) || report.schemaVersion !== 1) return ['report schemaVersion must be 1'];
  if (!exactKeys(report, ['$schema', 'schemaVersion', 'packId', 'packVersion', 'generatedAt', 'ledgerEntryHash', 'outcomes'])) failures.push('report has an unexpected or missing property');
  if (report.$schema !== EVIDENCE_SCHEMA_ID) failures.push(`report $schema must be ${EVIDENCE_SCHEMA_ID}`);
  if (report.packId !== pack.id || report.packVersion !== pack.version) failures.push('report pack identity or version does not match');
  if (typeof report.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(report.generatedAt) || !Number.isFinite(Date.parse(report.generatedAt))) failures.push('generatedAt must be an ISO timestamp');
  if (!HASH.test(report.ledgerEntryHash || '')) failures.push('ledgerEntryHash must be a sha256 digest');
  const outcomes = Array.isArray(report.outcomes) ? report.outcomes : [];
  const byOutcome = new Map(outcomes.map((item) => [item?.outcome, item]));
  if (byOutcome.size !== outcomes.length || byOutcome.size !== pack.outcomes.length) failures.push('report must contain every outcome exactly once');
  for (const mapping of pack.evidence.outcomeEvidence) {
    const item = byOutcome.get(mapping.outcome);
    if (!plain(item) || !['verified', 'unverified'].includes(item.status) || !Array.isArray(item.evidence) || item.evidence.length === 0) { failures.push(`outcome '${mapping.outcome}' has no bounded evidence result`); continue; }
    if (!exactKeys(item, ['outcome', 'status', 'evidence'])) failures.push(`outcome '${mapping.outcome}' has an unexpected or missing property`);
    const evidenceIds = new Set();
    for (const evidence of item.evidence) {
      if (!exactKeys(evidence, ['artifactId', 'evidenceHash', 'claim'])) failures.push(`outcome '${mapping.outcome}' has malformed evidence structure`);
      if (!plain(evidence) || !mapping.memberArtifactIds.includes(evidence.artifactId)) failures.push(`outcome '${mapping.outcome}' cites an undeclared member`);
      else if (evidenceIds.has(evidence.artifactId)) failures.push(`outcome '${mapping.outcome}' repeats member evidence`);
      else evidenceIds.add(evidence.artifactId);
      if (!HASH.test(evidence?.evidenceHash || '')) failures.push(`outcome '${mapping.outcome}' has an invalid evidence hash`);
      if (typeof evidence?.claim !== 'string' || evidence.claim.length < 10 || evidence.claim.length > 500) failures.push(`outcome '${mapping.outcome}' has an invalid claim`);
    }
    if (item.status === 'verified' && mapping.memberArtifactIds.some((id) => !evidenceIds.has(id))) failures.push(`verified outcome '${mapping.outcome}' omits declared member evidence`);
  }
  return failures;
}

export function main(argv = process.argv.slice(2)) {
  const packIndex = argv.indexOf('--pack');
  const reportIndex = argv.indexOf('--report');
  if (packIndex < 0 || reportIndex < 0 || !argv[packIndex + 1] || !argv[reportIndex + 1]) throw new Error('usage: verify-pack-evidence --pack <slug> --report <file>');
  const pack = resolvePack(argv[packIndex + 1]).manifest;
  const failures = verifyPackEvidence(pack, readPackEvidenceReport(path.resolve(argv[reportIndex + 1])));
  process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, packId: pack.id, failures })}\n`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
