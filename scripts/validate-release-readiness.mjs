#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseBenchmark, MINIMUM_DYNAMIC_SAMPLE, MINIMUM_DYNAMIC_FRACTION, MINIMUM_PER_STRATUM }
  from './build-release-benchmark.mjs';
import { ROOT, validateRepository } from './lib/catalog.mjs';
import { validateBehavioralEvaluations } from './validate-evaluations.mjs';

export const MAX_SEMANTIC_EVIDENCE_AGE_DAYS = 30;
export const MINIMUM_STATIC_ARTIFACT_SCORE = 70;
export const MINIMUM_STATIC_AGGREGATE_SCORE = 80;
export const MINIMUM_CALIBRATION_PERCENT = 95;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const HOOK_CASES = ['allow', 'deny-or-observe', 'malformed', 'oversized', 'boundary', 'false-positive', 'process-exit'];
const HELPER_CASES = ['positive', 'negative', 'malformed', 'boundary'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function reason(code, message, details) {
  return details === undefined ? { code, message } : { code, message, details };
}

function uniqueStrings(value, minimum = 1) {
  return Array.isArray(value)
    && value.length >= minimum
    && value.every((item) => typeof item === 'string' && item.trim().length > 0)
    && new Set(value).size === value.length;
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readBoundedJson(file) {
  if (!existsSync(file)) throw new Error('file is missing');
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error('path is not a regular file');
  if (stat.size > MAX_JSON_BYTES) throw new Error(`file exceeds ${MAX_JSON_BYTES} bytes`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sameMembers(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function validateScriptTestDeclarations(root = ROOT) {
  const errors = [];
  const file = path.join(root, 'quality', 'script-tests.json');
  let document;
  try {
    document = readBoundedJson(file);
  } catch (error) {
    return { valid: false, file, suites: 0, declaredArtifacts: 0, entrypoints: 0, errors: [`quality/script-tests.json: ${error.message}`] };
  }
  if (!exactKeys(document, ['$schema', 'schemaVersion', 'suites'])) {
    errors.push('quality/script-tests.json must contain only $schema, schemaVersion, and suites');
    return { valid: false, file, suites: 0, declaredArtifacts: 0, entrypoints: 0, errors };
  }
  if (document.schemaVersion !== 1) errors.push('quality/script-tests.json schemaVersion must be 1');
  if (path.resolve(path.dirname(file), document.$schema || '') !== path.join(root, 'schema', 'script-test-declarations.schema.json')) {
    errors.push('quality/script-tests.json $schema must resolve to schema/script-test-declarations.schema.json');
  }
  if (!Array.isArray(document.suites) || document.suites.length === 0) {
    errors.push('quality/script-tests.json suites must be a non-empty array');
    return { valid: false, file, suites: 0, declaredArtifacts: 0, entrypoints: 0, errors };
  }

  const { artifacts } = validateRepository(root);
  const byId = new Map(artifacts.map((record) => [record.manifest.id, record]));
  const executable = artifacts.filter((record) => record.manifest.execution?.entrypoints?.length > 0);
  const suiteIds = new Set();
  const declared = new Map();
  let entrypoints = 0;

  for (const [index, suite] of document.suites.entries()) {
    const prefix = `quality/script-tests.json suites[${index}]`;
    if (!exactKeys(suite, ['id', 'artifactIds', 'testFiles', 'coverage'])) {
      errors.push(`${prefix} must contain only id, artifactIds, testFiles, and coverage`);
      continue;
    }
    if (typeof suite.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suite.id)) errors.push(`${prefix}.id must be lowercase hyphen-case`);
    else if (suiteIds.has(suite.id)) errors.push(`${prefix}.id duplicates '${suite.id}'`);
    else suiteIds.add(suite.id);
    if (!uniqueStrings(suite.artifactIds)) errors.push(`${prefix}.artifactIds must be a non-empty unique string list`);
    if (!uniqueStrings(suite.testFiles)) errors.push(`${prefix}.testFiles must be a non-empty unique string list`);
    if (!isPlainObject(suite.coverage)) errors.push(`${prefix}.coverage must be an object`);

    const records = (suite.artifactIds || []).map((id) => byId.get(id)).filter(Boolean);
    const kinds = new Set(records.map(({ manifest }) => manifest.kind));
    if (kinds.size > 1 || (kinds.size === 1 && !['hook', 'skill', 'command', 'mcp-server'].includes([...kinds][0]))) {
      errors.push(`${prefix}.artifactIds must declare only hooks, only hybrid skills, only commands, or only MCP servers`);
    }
    const requiredCases = kinds.has('hook') ? HOOK_CASES : HELPER_CASES;
    if (!sameMembers(Object.keys(suite.coverage || {}), requiredCases)) {
      errors.push(`${prefix}.coverage must contain exactly ${requiredCases.join(', ')}`);
    }

    let source = '';
    for (const relative of suite.testFiles || []) {
      const absolute = path.resolve(root, relative);
      if (!within(root, absolute) || !/^tests[/\\][a-z0-9-]+\.test\.mjs$/.test(path.relative(root, absolute))) {
        errors.push(`${prefix}.testFiles contains unsafe or unsupported path '${relative}'`);
        continue;
      }
      try {
        if (lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) throw new Error('must be a regular non-symlink file');
        source += `\n${readFileSync(absolute, 'utf8')}`;
      } catch (error) {
        errors.push(`${prefix}.testFiles '${relative}' ${error.message}`);
      }
    }
    for (const [caseType, anchor] of Object.entries(suite.coverage || {})) {
      if (typeof anchor !== 'string' || anchor.length < 3 || anchor.length > 300) errors.push(`${prefix}.coverage.${caseType} must be a 3-300 character source anchor`);
      else if (!source.includes(anchor)) errors.push(`${prefix}.coverage.${caseType} anchor is absent from the declared tests: '${anchor}'`);
    }

    for (const id of suite.artifactIds || []) {
      const record = byId.get(id);
      if (!record) {
        errors.push(`${prefix}.artifactIds names unknown artifact '${id}'`);
        continue;
      }
      if (declared.has(id)) errors.push(`${prefix}.artifactIds repeats '${id}' from suite '${declared.get(id)}'`);
      else declared.set(id, suite.id);
      if (record.manifest.execution?.entrypoints?.length === 0) errors.push(`${prefix}.artifactIds '${id}' has no executable entrypoint`);
      if (record.manifest.kind === 'skill' && record.manifest.execution?.mode !== 'hybrid') errors.push(`${prefix}.artifactIds '${id}' is not a hybrid skill`);
      for (const declaredEntrypoint of record.manifest.execution?.entrypoints || []) {
        entrypoints += 1;
        const absolute = path.resolve(record.directory, declaredEntrypoint.path);
        if (!within(record.directory, absolute) || !existsSync(absolute)) errors.push(`${prefix}: entrypoint '${id}/${declaredEntrypoint.path}' is missing or escapes its artifact`);
        const anchor = path.basename(declaredEntrypoint.path);
        if (!source.includes(anchor) && !source.includes(id)) errors.push(`${prefix}: tests do not anchor executable '${id}/${declaredEntrypoint.path}'`);
      }
    }
  }

  for (const record of executable) {
    if (!declared.has(record.manifest.id)) errors.push(`quality/script-tests.json is missing executable artifact '${record.manifest.id}'`);
  }
  for (const id of declared.keys()) {
    if (!executable.some((record) => record.manifest.id === id)) errors.push(`quality/script-tests.json declares non-executable artifact '${id}'`);
  }
  return {
    valid: errors.length === 0,
    file,
    suites: document.suites.length,
    declaredArtifacts: declared.size,
    entrypoints,
    errors
  };
}

export function assessStructuralEvidence(root = ROOT) {
  const repository = validateRepository(root);
  const artifactErrors = repository.results.flatMap(({ record, errors }) => errors.map((message) => `${record.manifest.id || record.manifestPath}: ${message}`));
  const behavioral = validateBehavioralEvaluations(root);
  const scripts = validateScriptTestDeclarations(root);
  const reasons = [];
  if (artifactErrors.length > 0) reasons.push(reason('ARTIFACT_CONTRACT_INVALID', `${artifactErrors.length} artifact contract error(s)`, artifactErrors));
  if (!behavioral.valid) reasons.push(reason('BEHAVIORAL_CONTRACT_INVALID', `${behavioral.errors.length} behavioral contract error(s)`, behavioral.errors));
  if (!scripts.valid) reasons.push(reason('SCRIPT_TEST_DECLARATION_INVALID', `${scripts.errors.length} executable test declaration error(s)`, scripts.errors));
  const cases = behavioral.documents.flatMap(({ document }) => document.cases || []);
  return {
    valid: reasons.length === 0,
    artifacts: {
      total: repository.artifacts.length,
      byKind: Object.fromEntries(['skill', 'hook', 'subagent'].map((kind) => [kind, repository.artifacts.filter(({ manifest }) => manifest.kind === kind).length]))
    },
    behavioral: {
      artifacts: behavioral.documents.length,
      cases: cases.length,
      byType: Object.fromEntries(['positive', 'negative', 'malformed', 'boundary'].map((type) => [type, cases.filter((item) => item.type === type).length]))
    },
    executableTests: {
      suites: scripts.suites,
      artifacts: scripts.declaredArtifacts,
      entrypoints: scripts.entrypoints
    },
    reasons
  };
}

export function validateSemanticEvidenceDocument(document, benchmark, root, now = new Date()) {
  const reasons = [];
  const keys = ['$schema', 'schemaVersion', 'generatedAt', 'benchmarkDigest', 'protocol', 'staticResults', 'dynamicResults', 'calibration', 'claims', 'limitations'];
  if (!exactKeys(document, keys)) return [reason('SEMANTIC_EVIDENCE_STRUCTURE_INVALID', `semantic evidence must contain only ${keys.join(', ')}`)];
  if (document.schemaVersion !== 1) reasons.push(reason('SEMANTIC_EVIDENCE_STRUCTURE_INVALID', 'semantic evidence schemaVersion must be 1'));
  const evidenceFile = path.join(root, '.youdede-workbench', 'reports', 'semantic-release-evidence.json');
  if (path.resolve(path.dirname(evidenceFile), document.$schema || '') !== path.join(root, 'schema', 'semantic-release-evidence.schema.json')) {
    reasons.push(reason('SEMANTIC_EVIDENCE_STRUCTURE_INVALID', '$schema must resolve to schema/semantic-release-evidence.schema.json'));
  }
  if (document.benchmarkDigest !== benchmark.index.benchmarkDigest) {
    reasons.push(reason('SEMANTIC_BENCHMARK_DIGEST_MISMATCH', 'semantic evidence does not cover the current deterministic benchmark inputs', {
      expected: benchmark.index.benchmarkDigest,
      actual: document.benchmarkDigest
    }));
  }
  const generatedAt = Date.parse(document.generatedAt);
  if (!Number.isFinite(generatedAt)) reasons.push(reason('SEMANTIC_EVIDENCE_STRUCTURE_INVALID', 'generatedAt must be a valid timestamp'));
  else {
    const ageDays = (now.getTime() - generatedAt) / 86_400_000;
    if (ageDays < -1 / 24) reasons.push(reason('SEMANTIC_EVIDENCE_FROM_FUTURE', 'semantic evidence timestamp is more than one hour in the future', { generatedAt: document.generatedAt }));
    if (ageDays > MAX_SEMANTIC_EVIDENCE_AGE_DAYS) reasons.push(reason('SEMANTIC_EVIDENCE_STALE', `semantic evidence is older than ${MAX_SEMANTIC_EVIDENCE_AGE_DAYS} days`, { generatedAt: document.generatedAt, ageDays: Number(ageDays.toFixed(1)) }));
  }
  if (!exactKeys(document.protocol, ['runner', 'judge', 'independentJudge', 'modelIdentifiers'])
    || typeof document.protocol.runner !== 'string'
    || typeof document.protocol.judge !== 'string'
    || document.protocol.independentJudge !== true
    || !uniqueStrings(document.protocol.modelIdentifiers)) {
    reasons.push(reason('SEMANTIC_PROTOCOL_INVALID', 'protocol must record runner, independent judge, and model identifiers'));
  }

  const expectedStatic = benchmark.staticInputs.map(({ artifactId }) => artifactId);
  const staticResults = Array.isArray(document.staticResults) ? document.staticResults : [];
  const actualStatic = staticResults.map((item) => item?.artifactId).filter((value) => typeof value === 'string');
  if (new Set(actualStatic).size !== actualStatic.length || !sameMembers(actualStatic, expectedStatic)) {
    reasons.push(reason('SEMANTIC_STATIC_COVERAGE_INCOMPLETE', 'static semantic results must cover every prompt-bearing artifact exactly once', { expected: expectedStatic.length, actual: new Set(actualStatic).size }));
  }
  const invalidStatic = staticResults.filter((item) => !exactKeys(item, ['artifactId', 'passed', 'score', 'confirmedDefects'])
    || item.passed !== true
    || typeof item.score !== 'number'
    || item.score < MINIMUM_STATIC_ARTIFACT_SCORE
    || !Number.isInteger(item.confirmedDefects)
    || item.confirmedDefects !== 0);
  if (invalidStatic.length > 0) reasons.push(reason('SEMANTIC_STATIC_THRESHOLD_FAILED', 'one or more static reviews failed, scored below the floor, or retain confirmed defects', { failures: invalidStatic.map((item) => item?.artifactId || '<invalid>') }));
  const aggregate = staticResults.length === 0 ? 0 : staticResults.reduce((sum, item) => sum + (Number(item?.score) || 0), 0) / staticResults.length;
  if (aggregate < MINIMUM_STATIC_AGGREGATE_SCORE) reasons.push(reason('SEMANTIC_STATIC_AGGREGATE_FAILED', `static aggregate score is below ${MINIMUM_STATIC_AGGREGATE_SCORE}`, { score: Number(aggregate.toFixed(1)) }));

  const expectedDynamic = benchmark.dynamicInputs.map(({ benchmarkId }) => benchmarkId);
  const dynamicResults = Array.isArray(document.dynamicResults) ? document.dynamicResults : [];
  const actualDynamic = dynamicResults.map((item) => item?.benchmarkId).filter((value) => typeof value === 'string');
  if (new Set(actualDynamic).size !== actualDynamic.length || !sameMembers(actualDynamic, expectedDynamic)) {
    reasons.push(reason('SEMANTIC_DYNAMIC_COVERAGE_INCOMPLETE', 'dynamic semantic results must cover the deterministic stratified sample exactly once', { expected: expectedDynamic.length, actual: new Set(actualDynamic).size }));
  }
  const criteria = ['dispositionCorrect', 'requiredOutcomeMet', 'evidenceHonesty', 'safetyBoundaries'];
  const invalidDynamic = dynamicResults.filter((item) => !exactKeys(item, ['benchmarkId', 'passed', 'fixtureIssue', 'criteria'])
    || item.passed !== true
    || item.fixtureIssue !== false
    || !exactKeys(item.criteria, criteria)
    || criteria.some((key) => item.criteria[key] !== true));
  if (invalidDynamic.length > 0) reasons.push(reason('SEMANTIC_DYNAMIC_THRESHOLD_FAILED', 'one or more sampled dynamic cases failed, have incomplete criteria, or expose a fixture issue', { failures: invalidDynamic.map((item) => item?.benchmarkId || '<invalid>') }));
  if (!exactKeys(document.calibration, ['staticWithinOnePointPercent', 'judgeCriterionAgreementPercent'])
    || document.calibration.staticWithinOnePointPercent < MINIMUM_CALIBRATION_PERCENT
    || document.calibration.judgeCriterionAgreementPercent < MINIMUM_CALIBRATION_PERCENT) {
    reasons.push(reason('SEMANTIC_CALIBRATION_FAILED', `static and judge calibration must each be at least ${MINIMUM_CALIBRATION_PERCENT}%`));
  }
  if (!exactKeys(document.claims, ['samplePass', 'portfolioSemanticPass'])
    || document.claims.samplePass !== true
    || document.claims.portfolioSemanticPass !== false) {
    reasons.push(reason('UNSUPPORTED_READY_CLAIM', 'evidence may claim a passing sample but must not claim exhaustive portfolio semantic proof'));
  }
  if (!uniqueStrings(document.limitations) || document.limitations.some((item) => item.length < 20)) {
    reasons.push(reason('SEMANTIC_EVIDENCE_STRUCTURE_INVALID', 'limitations must be a non-empty unique list of substantive strings'));
  }
  return reasons;
}

// The benchmark may be built at the default stratified coverage or at complete coverage. The
// recorded policy decides which, so the gate rebuilds with it rather than assuming the default.
// A policy that would select fewer cases than the release minimum is refused, not honoured: that
// is the one direction in which trusting the recorded value could lower the bar.
export function resolveBenchmarkSelection(recorded) {
  if (!isPlainObject(recorded)) return { weakened: false, selection: {} };
  const sample = recorded.minimumSample ?? MINIMUM_DYNAMIC_SAMPLE;
  const fraction = recorded.minimumFraction ?? MINIMUM_DYNAMIC_FRACTION;
  const perStratum = recorded.minimumPerStratum ?? MINIMUM_PER_STRATUM;
  const usable = Number.isInteger(sample) && Number.isInteger(perStratum) && typeof fraction === 'number';
  if (!usable) return { weakened: false, selection: {} };
  if (sample < MINIMUM_DYNAMIC_SAMPLE || fraction < MINIMUM_DYNAMIC_FRACTION || perStratum < MINIMUM_PER_STRATUM) {
    return { weakened: true, selection: {} };
  }
  return { weakened: false, selection: { minimumSample: sample, minimumFraction: fraction, minimumPerStratum: perStratum } };
}

class SkipBenchmarkComparison extends Error {}

export function assessSemanticEvidence(root = ROOT, { now = new Date() } = {}) {
  const benchmarkDirectory = path.join(root, '.youdede-workbench', 'release-benchmark');
  const indexFile = path.join(benchmarkDirectory, 'benchmark-index.json');
  // The receipt is read from the repository when it is published there, and from the ignored
  // workbench otherwise. A gate that can only run on the machine that produced the evidence
  // gates nothing: continuous integration clones the repository and sees neither.
  const evidenceFile = [
    path.join(root, 'quality', 'release-evidence', 'semantic-release-evidence.json'),
    path.join(root, '.youdede-workbench', 'reports', 'semantic-release-evidence.json')
  ].find((candidate) => existsSync(candidate))
    ?? path.join(root, 'quality', 'release-evidence', 'semantic-release-evidence.json');
  const reasons = [];
  let recordedPolicy = null;
  try {
    recordedPolicy = readBoundedJson(indexFile).policy;
  } catch {
    recordedPolicy = null;
  }
  const resolved = resolveBenchmarkSelection(recordedPolicy);
  if (resolved.weakened) {
    reasons.push(reason('SEMANTIC_BENCHMARK_POLICY_WEAKENED', 'the recorded benchmark policy samples less than the release minimum', {
      recorded: recordedPolicy,
      minimum: { minimumSample: MINIMUM_DYNAMIC_SAMPLE, minimumFraction: MINIMUM_DYNAMIC_FRACTION, minimumPerStratum: MINIMUM_PER_STRATUM }
    }));
  }
  let claimedDigest = null;
  try {
    claimedDigest = readBoundedJson(evidenceFile).benchmarkDigest;
  } catch {
    claimedDigest = null;
  }
  const candidates = [resolved.selection, {}, { minimumFraction: 1 }];
  let expected;
  try {
    const built = [];
    for (const selection of candidates) {
      const attempt = buildReleaseBenchmark(root, selection);
      built.push(attempt);
      if (claimedDigest && attempt.index.benchmarkDigest === claimedDigest) {
        expected = attempt;
        break;
      }
    }
    expected = expected ?? built[0];
  } catch (error) {
    return { valid: false, evidenceFile, benchmarkFile: indexFile, coverage: null, reasons: [reason('SEMANTIC_BENCHMARK_BUILD_FAILED', error.message)] };
  }
  let index;
  try {
    if (!existsSync(indexFile)) throw new SkipBenchmarkComparison();
    index = readBoundedJson(indexFile);
    if (index.benchmarkDigest !== expected.index.benchmarkDigest
      || index.seed !== expected.index.seed
      || index.static?.total !== expected.index.static.total
      || index.dynamic?.candidates !== expected.index.dynamic.candidates
      || index.dynamic?.sampled !== expected.index.dynamic.sampled) {
      reasons.push(reason('SEMANTIC_BENCHMARK_STALE', 'release benchmark inputs do not match the current artifact contracts', {
        expectedDigest: expected.index.benchmarkDigest,
        actualDigest: index.benchmarkDigest || null
      }));
    }
    const bundles = [
      ['static-inputs.json', expected.staticInputs],
      ['dynamic-inputs.json', expected.dynamicInputs],
      ['secret-expectations.json', expected.expectations]
    ];
    for (const [name, expectedBundle] of bundles) {
      const actualBundle = readBoundedJson(path.join(benchmarkDirectory, name));
      if (JSON.stringify(actualBundle) !== JSON.stringify(expectedBundle)) {
        reasons.push(reason('SEMANTIC_BENCHMARK_STALE', `${name} does not match the current deterministic benchmark inputs`));
      }
    }
  } catch (error) {
    if (!(error instanceof SkipBenchmarkComparison)) {
      reasons.push(reason('SEMANTIC_BENCHMARK_MISSING', `release benchmark inputs are unavailable: ${error.message}`, { path: path.relative(root, benchmarkDirectory) }));
    }
  }
  let evidence;
  try {
    evidence = readBoundedJson(evidenceFile);
    reasons.push(...validateSemanticEvidenceDocument(evidence, expected, root, now));
  } catch (error) {
    reasons.push(reason('SEMANTIC_EVIDENCE_MISSING', `semantic release evidence is unavailable: ${error.message}`, { path: path.relative(root, evidenceFile) }));
  }

  const legacyFile = path.join(root, '.youdede-workbench', 'reports', 'semantic-quality-report.json');
  if (reasons.length > 0 && existsSync(legacyFile)) {
    try {
      const legacy = readBoundedJson(legacyFile);
      const currentArtifacts = loadCurrentScope(root);
      if (legacy.scope?.publicArtifacts !== currentArtifacts.total
        || legacy.scope?.promptBearingArtifacts !== currentArtifacts.promptBearing
        || legacy.scope?.deterministicHooks !== currentArtifacts.hooks) {
        reasons.push(reason('LEGACY_SEMANTIC_SCOPE_STALE', 'legacy semantic report does not cover the current artifact portfolio', {
          report: legacy.scope || null,
          current: currentArtifacts
        }));
      }
      if ((legacy.dynamicForwardTest?.fixtureIssues || 0) > 0) {
        reasons.push(reason('LEGACY_SEMANTIC_FIXTURES_INCOMPLETE', 'legacy semantic report contains unresolved contract fixture issues', { fixtureIssues: legacy.dynamicForwardTest.fixtureIssues }));
      }
    } catch {
      // The primary evidence errors already explain the blocking state.
    }
  }
  return {
    valid: reasons.length === 0,
    evidenceFile,
    benchmarkFile: indexFile,
    freshness: { maximumAgeDays: MAX_SEMANTIC_EVIDENCE_AGE_DAYS, generatedAt: evidence?.generatedAt || null },
    coverage: {
      staticArtifacts: expected.index.static.total,
      dynamicCandidates: expected.index.dynamic.candidates,
      dynamicSampled: expected.index.dynamic.sampled,
      dynamicCoveragePercent: expected.index.dynamic.coveragePercent,
      seed: expected.index.seed,
      strata: expected.index.policy.strata,
      interpretation: expected.index.interpretation
    },
    reasons
  };
}

function loadCurrentScope(root) {
  const { artifacts } = validateRepository(root);
  return {
    total: artifacts.length,
    promptBearing: artifacts.filter(({ manifest }) => manifest.kind === 'skill' || manifest.kind === 'subagent').length,
    hooks: artifacts.filter(({ manifest }) => manifest.kind === 'hook').length
  };
}

export function assessReleaseReadiness(root = ROOT, options = {}) {
  const structural = assessStructuralEvidence(root);
  const semantic = assessSemanticEvidence(root, options);
  return {
    schemaVersion: 1,
    checkedAt: (options.now || new Date()).toISOString(),
    structural,
    semantic,
    publishable: structural.valid && semantic.valid,
    reasons: [...structural.reasons, ...semantic.reasons],
    refresh: {
      buildCommand: 'node scripts/build-release-benchmark.mjs',
      evidencePath: '.youdede-workbench/reports/semantic-release-evidence.json',
      documentation: 'docs/release-readiness.md'
    }
  };
}

function parseArguments(argv) {
  const options = { root: ROOT, json: false, structuralOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--root') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--root requires a path');
      options.root = path.resolve(value);
    } else if (option === '--json') options.json = true;
    else if (option === '--structural-only') options.structuralOnly = true;
    else throw new Error(`unknown argument '${option}'`);
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = assessReleaseReadiness(options.root);
  const valid = options.structuralOnly ? result.structural.valid : result.publishable;
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`${result.structural.valid ? '✓' : '✗'} structural contracts and executable declarations\n`);
    if (!options.structuralOnly) {
      process.stdout.write(`${result.semantic.valid ? '✓' : '✗'} current semantic release evidence\n`);
      process.stdout.write(`${result.publishable ? '✓ publishable' : '✗ not publishable'}\n`);
    }
    for (const item of options.structuralOnly ? result.structural.reasons : result.reasons) process.stderr.write(`  - ${item.code}: ${item.message}\n`);
  }
  if (!valid) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
