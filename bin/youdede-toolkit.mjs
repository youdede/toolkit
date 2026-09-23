#!/usr/bin/env node

import path from 'node:path';
import { hookBindings, loadArtifacts, loadPacks, resolvePack, ROOT, validateRepository } from '../scripts/lib/catalog.mjs';
import { doctor, installArtifact, installPack, planArtifactInstall, planPackInstall, removeArtifact, removePack, resolveArtifact } from '../scripts/lib/install.mjs';
import { readIntegrityManifest, verifyArtifactAttestation, verifyIntegrityManifest } from '../scripts/lib/integrity.mjs';
import { validateBehavioralEvaluations } from '../scripts/validate-evaluations.mjs';
import { readPackEvidenceReport, verifyPackEvidence } from '../scripts/verify-pack-evidence.mjs';
import { SUPPORTED_TARGETS } from '../scripts/lib/targets.mjs';

function parse(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    if (['dry-run', 'force', 'help', 'json'].includes(name)) options[name] = true;
    else {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`--${name} requires a value`);
      options[name] = next;
      index += 1;
    }
  }
  return { positional, options };
}

const INSTALL_FLAGS = ['target', 'scope', 'cwd', 'force', 'dry-run', 'json'];
const COMMAND_FLAGS = {
  help: [],
  list: ['kind', 'domain', 'category', 'capability', 'problem', 'framework', 'language', 'lifecycle', 'risk', 'target', 'execution'],
  info: ['target', 'scope', 'cwd'],
  packs: [],
  'pack-info': ['target', 'scope', 'cwd'],
  'verify-pack-evidence': ['report', 'json'],
  add: INSTALL_FLAGS,
  'add-pack': INSTALL_FLAGS,
  remove: ['target', 'scope', 'cwd', 'force'],
  'remove-pack': ['target', 'scope', 'cwd', 'force'],
  doctor: ['target', 'scope', 'cwd'],
  'verify-integrity': ['json'],
  validate: []
};

// An unrecognised flag is a typo, and the flags that decide where bytes land must never fall
// back to a default silently: `--scop user` used to install to project scope and exit 0.
function assertKnownFlags(command, options) {
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) throw new Error(`unknown command '${command}'`);
  const unknown = Object.keys(options).filter((name) => name !== 'help' && !allowed.includes(name));
  if (unknown.length) {
    const list = unknown.map((name) => `--${name}`).join(', ');
    const supported = allowed.length ? allowed.map((name) => `--${name}`).join(', ') : 'none';
    throw new Error(`${command} does not accept ${list}; supported flags: ${supported}`);
  }
}

function help() {
  const targets = SUPPORTED_TARGETS.join('|');
  process.stdout.write(`youdede-toolkit\n\n`);
  process.stdout.write(`  list [--kind value] [--domain value] [--category value] [--capability value] [--problem value]\n`);
  process.stdout.write(`       [--framework value] [--language value] [--lifecycle value] [--risk value] [--target value] [--execution value]\n`);
  process.stdout.write(`  info <id-or-slug>\n`);
  process.stdout.write(`  packs\n`);
  process.stdout.write(`  pack-info <id-or-slug>\n`);
  process.stdout.write(`  verify-pack-evidence <id-or-slug> --report path [--json]\n`);
  process.stdout.write(`  add <id-or-slug> [--target ${targets}] [--scope project|user] [--cwd path] [--dry-run] [--json] [--force]\n`);
  process.stdout.write(`  add-pack <id-or-slug> [--target ${targets}] [--scope project|user] [--cwd path] [--dry-run] [--json] [--force]\n`);
  process.stdout.write(`  remove <id-or-slug> [--target ${targets}] [--scope project|user] [--cwd path] [--force]\n`);
  process.stdout.write(`  remove-pack <id-or-slug> [--target ${targets}] [--scope project|user] [--cwd path] [--force]\n`);
  process.stdout.write(`  doctor [--target ${targets}] [--scope project|user] [--cwd path]\n`);
  process.stdout.write(`  verify-integrity [id-or-slug] [--json]\n`);
  process.stdout.write(`  validate\n`);
}

function printRuntimeDisclosure(runtime) {
  if (!runtime) return;
  process.stdout.write(`Runtime disclosure: ${runtime.trustBoundary}\n`);
  process.stdout.write(`- behavior: ${runtime.behavior}; failure policy: ${runtime.failurePolicy}; retention: ${runtime.dataRetention}\n`);
  if (runtime.runtimeDependencies.length) process.stdout.write(`- runtime dependencies: ${runtime.runtimeDependencies.join(', ')}\n`);
  if (runtime.activation !== 'Target-native discovery applies.') process.stdout.write(`- activation: ${runtime.activation}\n`);
  for (const limitation of runtime.limitations) process.stdout.write(`- limitation: ${limitation}\n`);
}

function requireQuery(positional) {
  if (!positional[1]) throw new Error(`${positional[0]} requires an artifact id or slug`);
  return positional[1];
}

async function main() {
  const { positional, options } = parse(process.argv.slice(2));
  const command = positional[0];
  if (!command || options.help || command === 'help') return help();
  assertKnownFlags(command, options);

  if (command === 'list') {
    let records = loadArtifacts(ROOT);
    if (options.kind) records = records.filter(({ manifest }) => manifest.kind === options.kind);
    if (options.domain) records = records.filter(({ manifest }) => manifest.domain === options.domain);
    if (options.category) records = records.filter(({ manifest }) => manifest.category === options.category);
    if (options.capability) records = records.filter(({ manifest }) => manifest.capabilities.includes(options.capability));
    if (options.problem) records = records.filter(({ manifest }) => manifest.problems.includes(options.problem));
    if (options.framework) records = records.filter(({ manifest }) => manifest.frameworks.includes(options.framework));
    if (options.language) records = records.filter(({ manifest }) => manifest.languages.includes(options.language));
    if (options.lifecycle) records = records.filter(({ manifest }) => manifest.lifecycle.includes(options.lifecycle));
    if (options.risk) records = records.filter(({ manifest }) => manifest.risk === options.risk);
    if (options.target) records = records.filter(({ manifest }) => Object.hasOwn(manifest.adapters, options.target));
    if (options.execution) records = records.filter(({ manifest }) => manifest.execution.mode === options.execution);
    for (const { manifest } of records.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
      process.stdout.write(`${manifest.slug.padEnd(28)} ${manifest.kind.padEnd(9)} ${manifest.domain}/${manifest.category}\n`);
      process.stdout.write(`  ${manifest.summary}\n`);
    }
    process.stdout.write(`\n${records.length} artifact(s).\n`);
    return;
  }

  if (command === 'info') {
    const { manifest, directory, adapters } = resolveArtifact(requireQuery(positional));
    const integrityCatalog = readIntegrityManifest(ROOT);
    const integrity = integrityCatalog.artifacts.find(({ artifactId }) => artifactId === manifest.id);
    process.stdout.write(`${manifest.name} ${manifest.version}\n${manifest.id}\n\n${manifest.description}\n\n`);
    process.stdout.write(`Authors of this toolkit artifact: ${manifest.authors.join(', ')}\n`);
    if (integrity) process.stdout.write(`Integrity: ${integrity.integrityId}\n`);
    process.stdout.write(`Problems: ${manifest.problems.join(', ')}\n`);
    process.stdout.write(`Capabilities: ${manifest.capabilities.join(', ')}\n`);
    process.stdout.write(`Frameworks: ${manifest.frameworks.join(', ')}\n`);
    process.stdout.write(`Languages: ${manifest.languages.join(', ')}\n`);
    process.stdout.write(`Lifecycle: ${manifest.lifecycle.join(', ')}\n`);
    process.stdout.write(`Targets: ${Object.keys(manifest.adapters).join(', ')}\n`);
    process.stdout.write(`Target compatibility:\n`);
    for (const target of Object.keys(adapters).sort()) {
      const adapter = adapters[target].data;
      const limitations = adapter.limitations?.length ? `; limitations: ${adapter.limitations.join(' | ')}` : '';
      process.stdout.write(`- ${target} (${adapter.stability || 'stable'}; scopes: ${adapter.scopes.join(', ')})${limitations}\n`);
    }
    process.stdout.write(`Risk: ${manifest.risk}\n`);
    process.stdout.write(`Risk reason: ${manifest.risk_reason}\n`);
    process.stdout.write(`Execution: ${manifest.execution.mode}\n`);
    process.stdout.write(`Behavior: ${manifest.operational.behavior}; failure policy: ${manifest.operational.failurePolicy}; latency: ${manifest.operational.latencyClass}\n`);
    process.stdout.write(`Latency reason: ${manifest.operational.latency_reason}\n`);
    if (manifest.relationships.packIds.length) process.stdout.write(`Packs: ${manifest.relationships.packIds.join(', ')}\n`);
    process.stdout.write(`\nRefuses:\n`);
    for (const refusal of manifest.refuses) process.stdout.write(`- ${refusal}\n`);
    process.stdout.write(`\nSource directory: ${path.relative(ROOT, directory)}\n`);
    return;
  }

  if (command === 'packs') {
    const packs = loadPacks(ROOT);
    for (const { manifest } of packs.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
      process.stdout.write(`${manifest.slug.padEnd(32)} ${manifest.members.length} members\n  ${manifest.summary}\n`);
    }
    process.stdout.write(`\n${packs.length} pack(s).\n`);
    return;
  }

  if (command === 'pack-info') {
    const { manifest } = resolvePack(requireQuery(positional));
    process.stdout.write(`${manifest.name} ${manifest.version}\n${manifest.id}\n\n${manifest.summary}\n\nOutcomes: ${manifest.outcomes.join(', ')}\nEvidence: ledger-linked; schema ${manifest.evidence.reportSchema}\nMembers:\n`);
    for (const member of manifest.members) process.stdout.write(`- ${member.artifactId} (${member.role}${member.required ? ', required' : ', optional'})\n`);
    // Fan-out is catalog data. Deriving it from an install plan made a read-only query depend on
    // the working directory and fail on unrelated workspace state, and made `pack-info` stat and
    // hash files under the user's config root as a side effect.
    const target = options.target || 'claude-code';
    const fanout = new Map();
    for (const member of manifest.members) {
      let record = null;
      try { record = resolveArtifact(member.artifactId); } catch { continue; }
      if (record.manifest.kind !== 'hook') continue;
      const adapter = record.adapters[target]?.data;
      if (!adapter) continue;
      for (const binding of hookBindings(adapter)) {
        const boundary = `${binding.event}:${binding.matcher}`;
        fanout.set(boundary, (fanout.get(boundary) || 0) + 1);
      }
    }
    if (fanout.size) process.stdout.write(`Hook fan-out: ${[...fanout].sort((a, b) => b[1] - a[1]).map(([boundary, count]) => `${boundary}=${count}`).join(', ')}\n`);
    return;
  }

  if (command === 'verify-pack-evidence') {
    const { manifest } = resolvePack(requireQuery(positional));
    if (!options.report) throw new Error('verify-pack-evidence requires --report <file>');
    const failures = verifyPackEvidence(manifest, readPackEvidenceReport(path.resolve(options.report)));
    const result = { ok: failures.length === 0, packId: manifest.id, packVersion: manifest.version, failures };
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.ok) process.stdout.write(`Pack evidence verified for ${manifest.id}@${manifest.version}.\n`);
    else for (const failure of failures) process.stdout.write(`- ${failure}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'add') {
    if (options['dry-run']) {
      const result = planArtifactInstall(requireQuery(positional), {
        target: options.target,
        scope: options.scope,
        cwd: options.cwd,
        force: options.force
      });
      if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`Would install ${result.artifact.id} in ${result.configRoot}\n`);
        if (result.integrity) process.stdout.write(`Verified ${result.integrity.integrityId}\n`);
        for (const file of result.writes) process.stdout.write(`- ${file.action} ${file.path} (${file.bytes} bytes, sha256 ${file.sha256})\n`);
        for (const file of result.removes) process.stdout.write(`- ${file.action} ${file.path}\n`);
        if (result.settings) process.stdout.write(`- ${result.settings.action} ${result.settings.path}\n`);
        if (result.mcpConfig) process.stdout.write(`- ${result.mcpConfig.action} ${result.mcpConfig.path}: ${result.mcpConfig.servers.join(', ')}\n`);
        process.stdout.write(`- update ${result.state.path}\n`);
        printRuntimeDisclosure(result.runtime);
        for (const warning of result.warnings || []) process.stdout.write(`Warning: ${warning}\n`);
      }
      return;
    }
    const result = installArtifact(requireQuery(positional), {
      target: options.target,
      scope: options.scope,
      cwd: options.cwd,
      force: options.force
    });
    process.stdout.write(`Installed ${result.artifact.id} in ${result.configRoot}\n`);
    for (const file of result.files) process.stdout.write(`- ${file}\n`);
    if (result.settingsFile) process.stdout.write(`- merged ${result.settingsFile}\n`);
    if (result.mcpConfigFile) process.stdout.write(`- merged ${result.mcpConfigFile}\n`);
    if (result.integrity) process.stdout.write(`- verified ${result.integrity.integrityId}\n`);
    printRuntimeDisclosure(result.runtime);
    for (const warning of result.warnings || []) process.stdout.write(`Warning: ${warning}\n`);
    return;
  }

  if (command === 'add-pack') {
    const installOptions = { target: options.target, scope: options.scope, cwd: options.cwd, force: options.force };
    if (options['dry-run']) {
      const result = planPackInstall(requireQuery(positional), installOptions);
      if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`Would install ${result.pack.id} for ${result.target}/${result.scope}\n`);
        for (const item of result.members) process.stdout.write(`- ${item.skipped ? 'skip' : 'install'} ${item.member.artifactId}${item.skipped ? `: ${item.skipped}` : ''}\n`);
      }
      return;
    }
    const result = installPack(requireQuery(positional), installOptions);
    process.stdout.write(`Installed ${result.pack.id} for ${result.target}/${result.scope}\n`);
    for (const item of result.installed) process.stdout.write(`- ${item.artifact.id}\n`);
    for (const item of result.skipped) process.stdout.write(`- skipped ${item.member.artifactId}: ${item.skipped}\n`);
    return;
  }

  if (command === 'remove') {
    const result = removeArtifact(requireQuery(positional), {
      target: options.target,
      scope: options.scope,
      cwd: options.cwd,
      force: options.force
    });
    process.stdout.write(`Removed ${result.artifact.id} from ${result.configRoot}\n`);
    return;
  }

  if (command === 'remove-pack') {
    const result = removePack(requireQuery(positional), {
      target: options.target,
      scope: options.scope,
      cwd: options.cwd,
      force: options.force
    });
    process.stdout.write(`Removed ${result.pack.id} for ${result.target}/${result.scope}\n`);
    return;
  }

  if (command === 'doctor') {
    const result = doctor({ target: options.target, scope: options.scope, cwd: options.cwd });
    if (result.configRoots) {
      process.stdout.write(`Install roots:\n`);
      for (const root of result.configRoots) process.stdout.write(`- ${root}\n`);
    } else {
      process.stdout.write(`Install root: ${result.configRoot}\n`);
    }
    process.stdout.write(`Recorded installs: ${result.installs}\n`);
    if (result.findings.length === 0) process.stdout.write('No state drift found.\n');
    else for (const finding of result.findings) process.stdout.write(`- ${finding.status}: ${finding.path} (${finding.key})\n`);
    if (result.findings.length) process.exitCode = 1;
    return;
  }

  if (command === 'verify-integrity') {
    const expected = readIntegrityManifest(ROOT);
    const query = positional[1];
    let result;
    if (query) {
      const record = resolveArtifact(query);
      const attestation = expected.artifacts.find(({ artifactId }) => artifactId === record.manifest.id);
      result = {
        rootDigest: expected.rootDigest,
        artifacts: 1,
        findings: verifyArtifactAttestation(record, attestation)
      };
    } else {
      result = verifyIntegrityManifest(loadArtifacts(ROOT), expected);
    }
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`Integrity root: sha256:${result.rootDigest}\n`);
      process.stdout.write(`Verified artifacts: ${result.artifacts}\n`);
      if (result.findings.length === 0) process.stdout.write('No integrity drift found.\n');
      else for (const finding of result.findings) {
        process.stdout.write(`- ${finding.status}: ${finding.path}${finding.artifactId ? ` (${finding.artifactId})` : ''}\n`);
      }
    }
    if (result.findings.length > 0) process.exitCode = 1;
    return;
  }

  if (command === 'validate') {
    const { artifacts, results, packs, packResults } = validateRepository();
    const errors = results.flatMap(({ record, errors: found }) => found.map((error) => `${record.manifest.id}: ${error}`));
    errors.push(...packResults.flatMap(({ record, errors: found }) => found.map((error) => `${record.manifest.id}: ${error}`)));
    const evaluations = validateBehavioralEvaluations();
    errors.push(...evaluations.errors);
    if (errors.length) throw new Error(errors.join('\n'));
    process.stdout.write(`${artifacts.length} artifacts, ${packs.length} packs, and ${evaluations.documents.length} behavioral evaluation contracts valid.\n`);
    return;
  }

  throw new Error(`unknown command '${command}'`);
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
