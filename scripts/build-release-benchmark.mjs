#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadArtifacts } from './lib/catalog.mjs';

export const RELEASE_BENCHMARK_SEED = 'youdede-release-semantic-v1';
export const MINIMUM_DYNAMIC_SAMPLE = 128;
export const MINIMUM_DYNAMIC_FRACTION = 0.20;
export const MINIMUM_PER_STRATUM = 1;
export const STRATA = ['kind', 'domain', 'risk', 'caseType'];

const DEFAULT_OUTPUT = path.join(ROOT, '.youdede-workbench', 'release-benchmark');

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function countBy(records, key) {
  return Object.fromEntries([...new Set(records.map((record) => record[key]))].sort().map((value) => [
    value,
    records.filter((record) => record[key] === value).length
  ]));
}

function readInstalledPrompt(record) {
  if (record.manifest.kind === 'skill') return readFileSync(path.join(record.directory, 'SKILL.md'), 'utf8');
  const mappings = Object.values(record.adapters)
    .flatMap(({ data }) => data.files || [])
    .filter(({ from }) => from.endsWith('.md'));
  const files = [...new Set(mappings.map(({ from }) => path.resolve(record.directory, from)))];
  if (files.length === 0) throw new Error(`${record.manifest.id} has no installed Markdown prompt payload`);
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

function stratum(record) {
  return STRATA.map((key) => record[key]).join('|');
}

function ranked(records, seed, suffix = '') {
  return [...records].sort((left, right) => {
    const leftRank = digest(`${seed}\0${suffix}\0${left.artifactId}\0${left.caseId}`);
    const rightRank = digest(`${seed}\0${suffix}\0${right.artifactId}\0${right.caseId}`);
    return leftRank.localeCompare(rightRank) || left.artifactId.localeCompare(right.artifactId) || left.caseId.localeCompare(right.caseId);
  });
}

export function selectStratifiedSample(candidates, {
  seed = RELEASE_BENCHMARK_SEED,
  minimumSample = MINIMUM_DYNAMIC_SAMPLE,
  minimumFraction = MINIMUM_DYNAMIC_FRACTION,
  minimumPerStratum = MINIMUM_PER_STRATUM
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (!Number.isInteger(minimumSample) || minimumSample < 1) throw new Error('minimumSample must be a positive integer');
  if (!(minimumFraction > 0 && minimumFraction <= 1)) throw new Error('minimumFraction must be greater than 0 and at most 1');
  if (!Number.isInteger(minimumPerStratum) || minimumPerStratum < 1) throw new Error('minimumPerStratum must be a positive integer');

  const groups = new Map();
  for (const candidate of candidates) {
    const key = stratum(candidate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const orderedGroups = [...groups].map(([key, records]) => ({ key, records: ranked(records, seed, key) }))
    .sort((left, right) => digest(`${seed}\0${left.key}`).localeCompare(digest(`${seed}\0${right.key}`)) || left.key.localeCompare(right.key));
  const required = Math.min(candidates.length, Math.max(
    minimumSample,
    Math.ceil(candidates.length * minimumFraction),
    orderedGroups.reduce((sum, group) => sum + Math.min(minimumPerStratum, group.records.length), 0)
  ));
  const selected = [];
  for (let index = 0; index < minimumPerStratum; index += 1) {
    for (const group of orderedGroups) if (group.records[index]) selected.push(group.records[index]);
  }
  for (let index = minimumPerStratum; selected.length < required; index += 1) {
    let added = false;
    for (const group of orderedGroups) {
      if (group.records[index]) {
        selected.push(group.records[index]);
        added = true;
        if (selected.length === required) break;
      }
    }
    if (!added) break;
  }
  return selected.sort((left, right) => left.artifactId.localeCompare(right.artifactId) || left.caseId.localeCompare(right.caseId));
}

export function buildReleaseBenchmark(root = ROOT, options = {}) {
  const artifacts = loadArtifacts(root).filter(({ manifest }) => ['skill', 'subagent', 'command', 'context'].includes(manifest.kind));
  const staticInputs = artifacts.map((record) => ({
    artifactId: record.manifest.id,
    kind: record.manifest.kind,
    domain: record.manifest.domain,
    risk: record.manifest.risk,
    installedInstructions: readInstalledPrompt(record)
  }));
  const candidates = artifacts.flatMap((record) => {
    const file = path.join(record.directory, 'evaluations', 'behavioral.json');
    if (!existsSync(file)) throw new Error(`${record.manifest.id} is missing evaluations/behavioral.json`);
    const evaluation = JSON.parse(readFileSync(file, 'utf8'));
    return evaluation.cases.map((item) => ({
      artifactId: record.manifest.id,
      caseId: item.id,
      caseType: item.type,
      kind: record.manifest.kind,
      domain: record.manifest.domain,
      risk: record.manifest.risk,
      installedInstructions: readInstalledPrompt(record),
      request: item.prompt,
      expected: item.expected
    }));
  });
  const sampled = selectStratifiedSample(candidates, options);
  const dynamicInputs = sampled.map(({ expected: _expected, caseType: _caseType, caseId: _caseId, ...record }, index) => ({
    benchmarkId: `dynamic-${String(index + 1).padStart(4, '0')}`,
    ...record
  }));
  const expectations = sampled.map((record, index) => ({
    benchmarkId: `dynamic-${String(index + 1).padStart(4, '0')}`,
    artifactId: record.artifactId,
    caseId: record.caseId,
    caseType: record.caseType,
    expected: record.expected
  }));
  const sampledWithIds = sampled.map((record, index) => ({ benchmarkId: `dynamic-${String(index + 1).padStart(4, '0')}`, ...record }));
  const strata = [...new Set(candidates.map(stratum))].sort().map((key) => ({
    key,
    candidates: candidates.filter((record) => stratum(record) === key).length,
    sampled: sampled.filter((record) => stratum(record) === key).length
  }));
  const byDimension = Object.fromEntries(STRATA.map((key) => [key, {
    candidates: countBy(candidates, key),
    sampled: countBy(sampled, key)
  }]));
  const benchmarkDigest = digest({ staticInputs, dynamicInputs, expectations });
  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    benchmarkDigest,
    seed: options.seed || RELEASE_BENCHMARK_SEED,
    policy: {
      strata: STRATA,
      minimumPerStratum: options.minimumPerStratum || MINIMUM_PER_STRATUM,
      minimumSample: options.minimumSample || MINIMUM_DYNAMIC_SAMPLE,
      minimumFraction: options.minimumFraction || MINIMUM_DYNAMIC_FRACTION
    },
    static: { total: staticInputs.length, coverage: 'all prompt-bearing artifacts' },
    dynamic: {
      candidates: candidates.length,
      sampled: sampled.length,
      coveragePercent: Number((sampled.length / candidates.length * 100).toFixed(1)),
      byDimension,
      strata
    },
    interpretation: sampled.length === candidates.length
      ? 'Dynamic inputs cover every candidate case. Complete coverage removes sampling error but not run-to-run variation, and is still not exhaustive portfolio semantic proof.'
      : 'Dynamic results estimate sampled behavior only and must not be reported as exhaustive portfolio semantic proof.'
  };
  return { index, staticInputs, dynamicInputs, expectations, sampledWithIds };
}

function parseArguments(argv) {
  const options = { output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--output') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
      options.output = path.resolve(value);
    } else if (option === '--full') {
      // Evaluate every candidate case instead of the stratified sample. Selection stays
      // deterministic and the recorded policy tells the gate which coverage to expect.
      options.minimumFraction = 1;
    } else throw new Error(`unknown argument '${option}'`);
  }
  return options;
}

function main() {
  const { output, ...selection } = parseArguments(process.argv.slice(2));
  const options = { output };
  const benchmark = buildReleaseBenchmark(ROOT, selection);
  mkdirSync(options.output, { recursive: true });
  for (const [name, value] of [
    ['benchmark-index.json', benchmark.index],
    ['static-inputs.json', benchmark.staticInputs],
    ['dynamic-inputs.json', benchmark.dynamicInputs],
    ['secret-expectations.json', benchmark.expectations]
  ]) writeFileSync(path.join(options.output, name), `${JSON.stringify(value, null, 2)}\n`);
  const { sampled, candidates } = benchmark.index.dynamic;
  process.stdout.write(sampled === candidates
    ? `Built ${benchmark.staticInputs.length} static inputs and every one of the ${candidates} dynamic cases.\n`
    : `Built ${benchmark.staticInputs.length} static inputs and a deterministic ${sampled}/${candidates} dynamic sample.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
