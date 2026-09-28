#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The Italian and Dutch translations of the user-facing reasons in catalog/artifacts.json: each
// artifact's risk and latency reasons (`reasons`, by slug) and each link's reason (`links`, by the
// slugs of its two ends). `sourceHash` covers every English source, so any edit to one needs the
// translations reviewed and the hash updated.
export function reasonSources(artifacts) {
  const slugOf = new Map(artifacts.map(({ id, slug }) => [id, slug]));
  const reasons = artifacts.map(({ slug, risk_reason, operational }) => [slug, risk_reason, operational.latency_reason]);
  reasons.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const links = artifacts.flatMap(({ slug, relationships }) => Object.entries(relationships.linkReasons ?? {})
    .map(([id, reason]) => [slug, slugOf.get(id), reason]));
  links.sort((a, b) => `${a[0]}\0${a[1]}` < `${b[0]}\0${b[1]}` ? -1 : 1);
  return { reasons, links, sourceHash: createHash('sha256').update(JSON.stringify({ reasons, links })).digest('hex') };
}

export function translationProblems(artifacts, bundles) {
  const { links, sourceHash } = reasonSources(artifacts);
  const slugs = new Set(artifacts.map(({ slug }) => slug));
  const problems = [];
  for (const [locale, bundle] of Object.entries(bundles)) {
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
    const expected = new Set(links.map(([from, to]) => `${from} -> ${to}`));
    for (const [from, to, reason] of links) {
      const translated = bundle.links?.[from]?.[to];
      if (!translated?.trim()) problems.push(`${locale}: missing link translation for ${from} -> ${to}`);
      else if (translated === reason) problems.push(`${locale}: untranslated link reason for ${from} -> ${to}`);
    }
    for (const [from, targets] of Object.entries(bundle.links ?? {})) {
      for (const to of Object.keys(targets)) if (!expected.has(`${from} -> ${to}`)) problems.push(`${locale}: unknown link ${from} -> ${to}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const artifacts = readJson('catalog/artifacts.json').artifacts;
  const problems = translationProblems(artifacts, Object.fromEntries(['it', 'nl'].map((locale) => [locale, readJson(`catalog/reasons.${locale}.json`)])));
  if (problems.length) {
    for (const problem of problems.slice(0, 30)) console.error(problem);
    process.exit(1);
  }
  console.log(`${artifacts.length} artifact reasons and ${reasonSources(artifacts).links.length} link reasons translated in it and nl`);
}
