#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const artifacts = readJson('catalog/artifacts.json').artifacts;
const source = artifacts.map(({ slug, risk_reason, operational }) => [slug, risk_reason, operational.latency_reason]);
source.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const sourceHash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
const slugs = new Set(artifacts.map(({ slug }) => slug));
const problems = [];

for (const locale of ['it', 'nl']) {
  const bundle = readJson(`catalog/reasons.${locale}.json`);
  if (bundle.sourceHash !== sourceHash) problems.push(`${locale}: source reasons changed`);
  for (const artifact of artifacts) {
    const translated = bundle.reasons[artifact.slug];
    if (!translated?.risk?.trim() || !translated?.latency?.trim()) {
      problems.push(`${locale}: missing translation for ${artifact.slug}`);
    } else if (translated.risk === artifact.risk_reason || translated.latency === artifact.operational.latency_reason) {
      problems.push(`${locale}: untranslated reason for ${artifact.slug}`);
    }
  }
  for (const slug of Object.keys(bundle.reasons)) {
    if (!slugs.has(slug)) problems.push(`${locale}: unknown artifact ${slug}`);
  }
}

if (problems.length) {
  for (const problem of problems.slice(0, 30)) console.error(problem);
  process.exit(1);
}
console.log(`${artifacts.length} artifact reasons translated in it and nl`);
