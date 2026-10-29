#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePackWorkflow, ROOT, validateRepository } from './lib/catalog.mjs';
import { ARTIFACT_KINDS, SUPPORTED_TARGETS } from './lib/targets.mjs';

const KIND_GUARANTEES = Object.freeze({
  skill: 'Prompt procedure with a validated trigger, payload, operational contract, and at least three concrete refusals.',
  hook: 'Executable guard with declared enforcing or observing behavior, failure policy, bounded adapter payload, and executable tests.',
  subagent: 'Narrow specialist whose native payload declares bounded tools or permissions and repeats its refusal boundary.',
  command: 'User invocation with an exact tool allowlist, declared preconditions, required evidence output, and authority-narrowing flags only.',
  context: 'Scoped and ordered rules with source provenance; a contradiction with a hook in the same install root blocks installation, and an expired context installs with a warning.',
  'mcp-server': 'Transport, egress, secret access, and trust boundaries are declared; local tools use description pins, while preview vendor servers use exact package and launch pins.'
});

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function list(values) {
  return values.length ? values.join(', ') : 'none';
}

function targetCoverage(records) {
  return SUPPORTED_TARGETS
    .map((target) => `${target} ${records.filter(({ adapters }) => adapters[target]).length}/${records.length}`)
    .join('; ');
}

function artifactKindRows(artifacts) {
  return ARTIFACT_KINDS.map((kind) => {
    const records = artifacts.filter(({ manifest }) => manifest.kind === kind);
    const behaviors = [...new Set(records.map(({ manifest }) => manifest.operational.behavior))].sort();
    const failurePolicies = [...new Set(records.map(({ manifest }) => manifest.operational.failurePolicy))].sort();
    const modes = [...new Set(records.map(({ manifest }) => manifest.execution.mode))].sort();
    const evidence = ['skill', 'subagent', 'command', 'context'].includes(kind)
      ? 'A checked four-case behavioral contract per artifact.'
      : kind === 'hook'
        ? 'Declared executable test coverage and process-exit behavior.'
        : kind === 'command'
          ? 'Declared precondition runtime plus executable helper tests where applicable.'
          : kind === 'context'
            ? 'Deterministic generation, provenance coverage, precedence, conflict, expiry, and removal tests.'
            : 'Profile/config parity, local capability drift, external exact-version launch, egress, secret-access, install, and removal tests.';
    return `| \`${kind}\` | ${records.length} | ${escapeCell(KIND_GUARANTEES[kind])} | modes: ${list(modes)}; behavior: ${list(behaviors)}; failure: ${list(failurePolicies)} | ${targetCoverage(records)} | ${escapeCell(evidence)} |`;
  });
}

function requiredComposition(manifest, byId) {
  const counts = new Map();
  for (const member of manifest.members.filter(({ required }) => required)) {
    const kind = byId.get(member.artifactId)?.manifest.kind ?? 'unknown';
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind} ${count}`).join(', ');
}

function packRows(packs, artifacts, root) {
  const byId = new Map(artifacts.map((record) => [record.manifest.id, record]));
  return packs.map(({ directory, manifest }) => {
    const workflow = analyzePackWorkflow(manifest, artifacts);
    const coordinates = workflow.compatibility
      .map(({ target, scopes }) => `${target} (${scopes.join('/')})`)
      .join('; ');
    const evaluationFile = path.join(directory, 'evaluations', 'behavioral.json');
    const evaluation = JSON.parse(readFileSync(evaluationFile, 'utf8'));
    const evidence = `ledger-linked report; ${manifest.evidence.outcomeEvidence.length} outcome mapping(s); ${evaluation.cases.length} recorded cases`;
    const packLink = path.relative(path.join(root, 'docs'), path.join(directory, 'pack.json')).split(path.sep).join('/');
    return `| [${escapeCell(manifest.name)}](${packLink}) | ${manifest.version} | ${escapeCell(manifest.summary)} | ${manifest.outcomes.map((outcome) => `\`${outcome}\``).join(', ')} | ${requiredComposition(manifest, byId)} | ${escapeCell(coordinates)} | ${escapeCell(evidence)} |`;
  });
}

export function renderCapabilityMatrix(root = ROOT) {
  const repository = validateRepository(root);
  const errors = [
    ...repository.results.flatMap(({ record, errors: failures }) => failures.map((failure) => `${record.manifest.id}: ${failure}`)),
    ...repository.packResults.flatMap(({ record, errors: failures }) => failures.map((failure) => `${record.manifest.id}: ${failure}`))
  ];
  if (errors.length) throw new Error(`cannot generate capability matrix from an invalid catalog:\n${errors.join('\n')}`);

  const lines = [
    '# Capability matrix',
    '',
    '<!-- Generated by scripts/generate-capability-docs.mjs. Do not edit by hand. -->',
    '',
    'This matrix states what the catalog contracts and tests actually guarantee. It is generated from artifact and pack manifests; `npm run check:capability-docs` refuses stale claims.',
    '',
    'A listed guarantee is a checked repository contract, not proof that every future model response or external system is correct. Target counts describe native adapters; a missing adapter is an explicit refusal to claim equivalent runtime semantics.',
    '',
    '## Artifact kinds',
    '',
    '| Kind | Count | Contract guarantee | Observed execution policy | Native adapter coverage | Evidence checked in CI |',
    '| --- | ---: | --- | --- | --- | --- |',
    ...artifactKindRows(repository.artifacts),
    '',
    '## Packs',
    '',
    'Every pack is versioned, maps every declared outcome to member evidence, requires a hash-linked session-ledger reference in its report, and has positive, missing-evidence, ledger-mismatch, and unsupported-coordinate scenarios.',
    '',
    '| Pack | Version | Checked capability | Outcomes | Required composition | Common install coordinates | Evidence contract |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...packRows(repository.packs, repository.artifacts, root),
    '',
    '## Claim boundaries',
    '',
    '- Integrity hashes prove byte identity against the catalog, not authorship or semantic correctness.',
    '- Behavioral cases and pack scenarios prove checked contract coverage; they do not establish exhaustive portfolio behavior.',
    '- Release publishability additionally requires current independent semantic evidence, a signed matching tag, publisher authority, and the provenance-capable OIDC workflow.',
    '- Native marketplace packages omit any composition or artifact kind whose runtime cannot preserve the declared contract.',
    ''
  ];
  return `${lines.join('\n')}\n`;
}

export function generateCapabilityDocs({ root = ROOT, check = false } = {}) {
  const file = path.join(root, 'docs', 'capability-matrix.md');
  const expected = renderCapabilityMatrix(root);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current === expected) return false;
  if (check) throw new Error('docs/capability-matrix.md is stale; run npm run capability:docs');
  writeFileSync(file, expected);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const changed = generateCapabilityDocs({ check: process.argv.includes('--check') });
    process.stdout.write(`${changed ? 'Generated' : 'Verified'} docs/capability-matrix.md.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
