#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadArtifacts, ROOT } from './lib/catalog.mjs';

const license = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
const notice = readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
const citation = readFileSync(path.join(ROOT, 'CITATION.cff'), 'utf8');
const errors = [];

if (!license.startsWith('MIT License\n') || !license.includes('Copyright (c) 2026 Youdede')) {
  errors.push('LICENSE must retain the current MIT text and contributor notice');
}
if (!notice.includes('SPDX-License-Identifier: MIT') || !notice.includes('does not prove authorship')
  || !notice.includes('No watermark, prompt, license notice, or checksum can force')) {
  errors.push('NOTICE must retain SPDX identity and the checksum/authorship/copying claim boundary');
}
if (!citation.includes('cff-version: 1.2.0') || !citation.includes('license: MIT')
  || !citation.includes('catalog/integrity.json root digest')) {
  errors.push('CITATION.cff must identify the MIT release and reproducible integrity root');
}
const { version, repository } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (!citation.includes(`\nversion: ${version}\n`)) errors.push(`CITATION.cff version must match package.json (${version})`);
if (!citation.includes(`repository-code: "${String(repository?.url ?? repository).replace(/^git\+/, '').replace(/\.git$/, '')}"`)) {
  errors.push('CITATION.cff repository-code must match the package.json repository');
}

let artifactCount = 0;
for (const { manifest } of loadArtifacts(ROOT)) {
  artifactCount++;
  if (manifest.license !== 'MIT') errors.push(`${manifest.id}: artifact license is not MIT`);
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exit(1);
}
// This checks declared licence metadata only. Originality is a contributor assertion recorded in
// NOTICE; no script in this repository can verify it, so this line must not claim otherwise.
process.stdout.write(`Legal metadata declares MIT for ${artifactCount} artifacts.\n`);
