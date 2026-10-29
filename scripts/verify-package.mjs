#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArtifacts, loadPacks } from './lib/catalog.mjs';
import { resolveNpmPackInvocation, spawnFailureDetail } from './verify-package-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message, detail = '') {
  process.stderr.write(`Package verification failed: ${message}${detail ? `\n${detail}` : ''}\n`);
  process.exit(1);
}

const invocation = resolveNpmPackInvocation();
const packed = spawnSync(invocation.command, invocation.argumentsList, {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  shell: invocation.shell
});

if (packed.status !== 0) fail('npm pack --dry-run did not complete', spawnFailureDetail(packed));

let result;
try {
  result = JSON.parse(packed.stdout);
} catch (error) {
  fail(`npm returned malformed pack metadata: ${error.message}`, packed.stdout.slice(0, 1_000));
}

if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].files)) {
  fail('npm returned an unsupported pack result');
}

const files = new Set(result[0].files.map((entry) => entry.path.replaceAll('\\', '/')));
const required = [
  'CITATION.cff',
  'LICENSE',
  'NOTICE',
  'README.md',
  'bin/youdede-toolkit.mjs',
  'catalog/artifacts.json',
  'catalog/reasons.it.json',
  'catalog/reasons.nl.json',
  'catalog/narratives.it.json',
  'catalog/narratives.nl.json',
  'catalog/integrity.json',
  'catalog/packs.json',
  'catalog/taxonomy.json',
  'package.json',
  'schema/adapter.schema.json',
  'schema/artifact.schema.json',
  'schema/evaluation.schema.json',
  'schema/pack.schema.json',
  'schema/script-test-declarations.schema.json',
  'schema/semantic-release-evidence.schema.json',
  'schema/taxonomy.schema.json',
  'quality/script-tests.json',
  'scripts/build-release-benchmark.mjs',
  'scripts/lib/catalog.mjs',
  'scripts/lib/install.mjs',
  'scripts/lib/integrity.mjs',
  'scripts/lib/targets.mjs',
  'scripts/runtime/hook-command-bridge.mjs',
  'scripts/runtime/opencode-guard-plugin.js',
  'scripts/lib/secret-scan.mjs',
  'scripts/validate-evaluations.mjs',
  'scripts/validate-release-readiness.mjs',
  'scripts/verify-package-command.mjs',
  'scripts/verify-secrets.mjs'
];

const packageManifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (packageManifest.publishConfig?.access !== 'public' || packageManifest.publishConfig?.provenance !== true) {
  fail('publishConfig must require public access and npm provenance');
}

for (const requiredPath of required) {
  if (!files.has(requiredPath)) fail(`required file '${requiredPath}' is missing from the package`);
}

for (const record of loadPacks(ROOT)) {
  const packPath = path.relative(ROOT, record.manifestPath).split(path.sep).join('/');
  if (!files.has(packPath)) fail(`pack manifest '${packPath}' is missing from the package`);
}

const forbidden = [
  /^\.youdede-workbench(?:\/|$)/,
  /^\.git(?:\/|$)/,
  /^\.claude(?:\/|$)/,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^docs\/plans(?:\/|$)/,
  /^node_modules(?:\/|$)/,
  /^tests(?:\/|$)/
];

for (const file of files) {
  if (forbidden.some((pattern) => pattern.test(file))) fail(`private or development-only path '${file}' would be published`);
}

// A published module whose relative import is not published fails when it is loaded.
for (const file of files) {
  if (!/\.m?js$/.test(file)) continue;
  const source = readFileSync(path.join(ROOT, file), 'utf8');
  for (const [, specifier] of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const imported = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    if (!files.has(imported)) fail(`'${file}' imports '${imported}', which is missing from the package`);
  }
}

for (const record of loadArtifacts(ROOT)) {
  const artifactRoot = path.relative(ROOT, record.directory).split(path.sep).join('/');
  const manifestPath = `${artifactRoot}/artifact.json`;
  if (!files.has(manifestPath)) fail(`artifact manifest '${manifestPath}' is missing from the package`);

  for (const [target, adapter] of Object.entries(record.adapters)) {
    const adapterPath = `${artifactRoot}/${record.manifest.adapters[target]}`;
    if (!files.has(adapterPath)) fail(`adapter '${adapterPath}' is missing from the package`);
    for (const mapping of adapter.data.files) {
      const sourcePrefix = (mapping.root === 'package' ? mapping.from : `${artifactRoot}/${mapping.from}`).replaceAll('\\', '/');
      const bundled = files.has(sourcePrefix) || [...files].some((file) => file.startsWith(`${sourcePrefix}/`));
      if (!mapping.optional && !bundled) fail(`adapter payload '${sourcePrefix}' is missing from the package`);
    }
  }

  for (const entrypoint of record.manifest.execution.entrypoints) {
    const entrypointPath = `${artifactRoot}/${entrypoint.path}`.replaceAll('\\', '/');
    if (!files.has(entrypointPath)) fail(`deterministic entrypoint '${entrypointPath}' is missing from the package`);
  }
  if (['skill', 'subagent', 'command', 'context'].includes(record.manifest.kind)) {
    const evaluationPath = `${artifactRoot}/evaluations/behavioral.json`;
    if (!files.has(evaluationPath)) fail(`behavioral contract '${evaluationPath}' is missing from the package`);
  }
}

process.stdout.write(`Package contains ${files.size} verified public files; private workbench paths are excluded.\n`);
