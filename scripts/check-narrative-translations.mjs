#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const artifacts = readJson('catalog/artifacts.json').artifacts.filter(({ kind }) => kind === 'mcp-server');
const source = artifacts.map(({ slug, summary, description, execution, refuses }) =>
  [slug, summary, description, execution.entrypoints.map(({ purpose }) => purpose), refuses]);
source.sort(([left], [right]) => left.localeCompare(right));
const sourceHash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
const known = new Set(artifacts.map(({ slug }) => slug));
const problems = [];

for (const locale of ['it', 'nl']) {
  const bundle = readJson(`catalog/narratives.${locale}.json`);
  if (bundle.sourceHash !== sourceHash) problems.push(`${locale}: source narratives changed`);
  for (const artifact of artifacts) {
    const translated = bundle.narratives[artifact.slug];
    const purposes = artifact.execution.entrypoints.map(({ purpose }) => purpose);
    if (!translated?.summary?.trim() || !translated?.description?.trim()
      || translated.purposes?.length !== purposes.length || translated.refuses?.length !== artifact.refuses.length) {
      problems.push(`${locale}: incomplete narrative for ${artifact.slug}`);
      continue;
    }
    for (const [english, localized] of [
      [artifact.summary, translated.summary], [artifact.description, translated.description],
      ...purposes.map((value, index) => [value, translated.purposes[index]]),
      ...artifact.refuses.map((value, index) => [value, translated.refuses[index]])
    ]) {
      if (!localized?.trim() || localized === english) problems.push(`${locale}: untranslated narrative for ${artifact.slug}`);
    }
  }
  for (const slug of Object.keys(bundle.narratives)) if (!known.has(slug)) problems.push(`${locale}: unknown artifact ${slug}`);
}

if (problems.length) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exit(1);
}
process.stdout.write(`${artifacts.length} MCP narratives translated in it and nl\n`);
