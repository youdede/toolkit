import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildReleaseBenchmark,
  RELEASE_BENCHMARK_SEED,
  selectStratifiedSample,
  MINIMUM_DYNAMIC_SAMPLE,
  MINIMUM_DYNAMIC_FRACTION
} from '../scripts/build-release-benchmark.mjs';
import {
  assessReleaseReadiness,
  assessStructuralEvidence,
  validateSemanticEvidenceDocument,
  resolveBenchmarkSelection
} from '../scripts/validate-release-readiness.mjs';
import { ROOT, validateRepository } from '../scripts/lib/catalog.mjs';

test('release structure covers every artifact contract, behavioral case, and executable entrypoint', () => {
  const repository = validateRepository(ROOT);
  const result = assessStructuralEvidence(ROOT);
  const promptArtifacts = repository.artifacts.filter(({ manifest }) => ['skill', 'subagent', 'command', 'context'].includes(manifest.kind));
  const entrypoints = repository.artifacts.flatMap(({ manifest }) => manifest.execution.entrypoints);
  assert.equal(result.valid, true, JSON.stringify(result.reasons, null, 2));
  assert.equal(result.artifacts.total, repository.artifacts.length);
  for (const kind of ['skill', 'hook', 'subagent', 'command', 'context', 'mcp-server']) {
    assert.equal(result.artifacts.byKind[kind], repository.artifacts.filter(({ manifest }) => manifest.kind === kind).length);
  }
  assert.equal(result.behavioral.artifacts, promptArtifacts.length);
  for (const type of ['positive', 'negative', 'malformed', 'boundary']) assert.ok(result.behavioral.byType[type] >= promptArtifacts.length, type);
  assert.equal(result.executableTests.artifacts, repository.artifacts.filter(({ manifest }) => manifest.execution.entrypoints.length > 0).length);
  assert.equal(result.executableTests.entrypoints, entrypoints.length);
});

test('dynamic selection is deterministic, stratified, and explicit about sampled coverage', () => {
  const records = [];
  for (const kind of ['skill', 'subagent']) for (const domain of ['development', 'security']) {
    for (const risk of ['low', 'high']) for (const caseType of ['positive', 'negative', 'malformed', 'boundary']) {
      for (let index = 0; index < 3; index += 1) records.push({
        artifactId: `${kind}/${domain}/fixture/artifact-${risk}-${caseType}-${index}`,
        caseId: `case-${index}`,
        kind,
        domain,
        risk,
        caseType
      });
    }
  }
  const left = selectStratifiedSample(records, { seed: RELEASE_BENCHMARK_SEED, minimumSample: 40, minimumFraction: 0.2 });
  const right = selectStratifiedSample([...records].reverse(), { seed: RELEASE_BENCHMARK_SEED, minimumSample: 40, minimumFraction: 0.2 });
  assert.deepEqual(left, right);
  assert.equal(left.length, 40);
  const strata = new Set(left.map((record) => [record.kind, record.domain, record.risk, record.caseType].join('|')));
  assert.equal(strata.size, 32);
});

test('release benchmark reviews every prompt statically and keeps sampled inputs blind', () => {
  const repository = validateRepository(ROOT);
  const left = buildReleaseBenchmark(ROOT);
  const right = buildReleaseBenchmark(ROOT);
  const promptCount = repository.artifacts.filter(({ manifest }) => ['skill', 'subagent', 'command', 'context'].includes(manifest.kind)).length;
  assert.equal(left.index.benchmarkDigest, right.index.benchmarkDigest);
  assert.equal(left.index.seed, RELEASE_BENCHMARK_SEED);
  assert.equal(left.staticInputs.length, promptCount);
  assert.equal(left.dynamicInputs.length, left.index.dynamic.sampled);
  assert.ok(left.index.dynamic.coveragePercent >= 20);
  assert.ok(left.index.dynamic.strata.every(({ sampled }) => sampled >= 1));
  for (const input of left.dynamicInputs) {
    assert.equal(Object.hasOwn(input, 'expected'), false);
    assert.equal(Object.hasOwn(input, 'caseType'), false);
    assert.equal(Object.hasOwn(input, 'caseId'), false);
  }
});

test('the gate honours a recorded benchmark policy but refuses a weakened one', () => {
  const full = { minimumSample: 128, minimumFraction: 1, minimumPerStratum: 1 };
  assert.deepEqual(resolveBenchmarkSelection(full), { weakened: false, selection: full });

  const dflt = { minimumSample: MINIMUM_DYNAMIC_SAMPLE, minimumFraction: MINIMUM_DYNAMIC_FRACTION, minimumPerStratum: 1 };
  assert.deepEqual(resolveBenchmarkSelection(dflt), { weakened: false, selection: dflt });

  // Each dimension below the release minimum is refused on its own.
  assert.equal(resolveBenchmarkSelection({ ...dflt, minimumFraction: 0.05 }).weakened, true);
  assert.equal(resolveBenchmarkSelection({ ...dflt, minimumSample: 10 }).weakened, true);
  assert.equal(resolveBenchmarkSelection({ ...dflt, minimumPerStratum: 0 }).weakened, true);

  // A missing or unusable policy falls back to the default, never to a weaker one.
  assert.deepEqual(resolveBenchmarkSelection(null), { weakened: false, selection: {} });
  assert.deepEqual(resolveBenchmarkSelection({ minimumFraction: 'most' }), { weakened: false, selection: {} });
});

test('complete coverage selects every candidate and says so, without weakening the sample', () => {
  const sample = buildReleaseBenchmark(ROOT);
  const full = buildReleaseBenchmark(ROOT, { minimumFraction: 1 });
  assert.equal(full.index.dynamic.sampled, full.index.dynamic.candidates);
  assert.equal(full.index.dynamic.coveragePercent, 100);
  assert.equal(full.dynamicInputs.length, full.index.dynamic.candidates);
  assert.ok(full.index.dynamic.sampled > sample.index.dynamic.sampled);
  assert.match(full.index.interpretation, /cover every candidate case/);
  assert.match(sample.index.interpretation, /sampled behavior only/);
  // Complete coverage still may not be reported as portfolio semantic proof.
  assert.match(full.index.interpretation, /not exhaustive portfolio semantic proof/);
  // Selection stays deterministic at full coverage too.
  assert.equal(buildReleaseBenchmark(ROOT, { minimumFraction: 1 }).index.benchmarkDigest, full.index.benchmarkDigest);
  for (const input of full.dynamicInputs) {
    assert.equal(Object.hasOwn(input, 'expected'), false);
    assert.equal(Object.hasOwn(input, 'caseType'), false);
  }
});

test('semantic evidence cannot turn sample success into a portfolio-ready claim', () => {
  const benchmark = buildReleaseBenchmark(ROOT);
  const document = {
    $schema: '../../schema/semantic-release-evidence.schema.json',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    benchmarkDigest: benchmark.index.benchmarkDigest,
    protocol: {
      runner: 'fixture runner',
      judge: 'fixture independent judge',
      independentJudge: true,
      modelIdentifiers: ['fixture-model-v1']
    },
    staticResults: benchmark.staticInputs.map(({ artifactId }) => ({ artifactId, passed: true, score: 100, confirmedDefects: 0 })),
    dynamicResults: benchmark.dynamicInputs.map(({ benchmarkId }) => ({
      benchmarkId,
      passed: true,
      fixtureIssue: false,
      criteria: { dispositionCorrect: true, requiredOutcomeMet: true, evidenceHonesty: true, safetyBoundaries: true }
    })),
    calibration: { staticWithinOnePointPercent: 100, judgeCriterionAgreementPercent: 100 },
    claims: { samplePass: true, portfolioSemanticPass: true },
    limitations: ['This synthetic fixture covers only the deterministic dynamic sample.']
  };
  const reasons = validateSemanticEvidenceDocument(document, benchmark, ROOT);
  assert.ok(reasons.some(({ code }) => code === 'UNSUPPORTED_READY_CLAIM'));
});

test('missing semantic evidence is reported without blocking publishability', { skip: process.platform === 'win32' }, (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'youdede-release-readiness-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['artifacts', 'catalog', 'packs', 'schema', 'scripts', 'tests']) {
    symlinkSync(path.join(ROOT, directory), path.join(root, directory), 'dir');
  }
  mkdirSync(path.join(root, 'quality'));
  for (const entry of readdirSync(path.join(ROOT, 'quality'))) {
    symlinkSync(path.join(ROOT, 'quality', entry), path.join(root, 'quality', entry));
  }

  const result = assessReleaseReadiness(root);
  assert.equal(result.structural.valid, true, JSON.stringify(result.structural.reasons, null, 2));
  assert.equal(result.publishable, true);
  assert.equal(result.semantic.valid, false);
  assert.ok(result.semantic.reasons.some(({ code }) => code === 'SEMANTIC_EVIDENCE_MISSING'));

  const cli = spawnSync(process.execPath, ['scripts/validate-release-readiness.mjs', '--structural-only', '--json'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).structural.valid, true);
});
