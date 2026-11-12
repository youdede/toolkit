#!/usr/bin/env node

import { statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { analyzePackWorkflow, hookBindings, loadArtifacts, loadPacks, loadTaxonomy, prerequisiteMembers, readJson, resolvePack, ROOT, validateRepository } from '../scripts/lib/catalog.mjs';
import { doctor, installArtifact, installedDependentsOf, installPack, listInstalled, planArtifactInstall, planArtifactRemoval, planPackInstall, planPackRemoval, removeArtifact, neededByMessage, removePack, resolveArtifact, suggestionsFor } from '../scripts/lib/install.mjs';
import { confirmRemoval, decidePrerequisites, parseAnswer, skippedNotice, suggestionHint } from '../scripts/lib/prerequisite-consent.mjs';
import { readIntegrityManifest, verifyArtifactAttestation, verifyIntegrityManifest } from '../scripts/lib/integrity.mjs';
import { validateBehavioralEvaluations } from '../scripts/validate-evaluations.mjs';
import { readPackEvidenceReport, verifyPackEvidence } from '../scripts/verify-pack-evidence.mjs';
import { DEFAULT_TARGET, SUPPORTED_TARGETS } from '../scripts/lib/targets.mjs';

function parse(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      // A one-dash spelling reaches no flag check at all: `-target codex` used to land among the
      // positionals, where no command reads it, so the install wrote to the default target and
      // exited 0. A lone `-` is left to the artifact lookup, which reports it as not found.
      if (value.length > 1 && value.startsWith('-')) {
        throw new Error(`unknown option '${value}'; options are spelled with two dashes`);
      }
      positional.push(value);
      continue;
    }
    const boolean = ['dry-run', 'force', 'help', 'json', 'no-prerequisites', 'version'];
    const equals = value.indexOf('=');
    if (equals > 2) {
      const name = value.slice(2, equals);
      if (boolean.includes(name)) throw new Error(`--${name} does not take a value`);
      if (equals === value.length - 1) throw new Error(`--${name} requires a value`);
      options[name] = value.slice(equals + 1);
      continue;
    }
    const name = value.slice(2);
    if (boolean.includes(name)) options[name] = true;
    else {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`--${name} requires a value`);
      options[name] = next;
      index += 1;
    }
  }
  return { positional, options };
}

const INSTALL_FLAGS = ['target', 'scope', 'cwd', 'force', 'dry-run', 'json', 'no-prerequisites'];
const REMOVE_FLAGS = ['target', 'scope', 'cwd', 'force', 'dry-run', 'json'];
// The dimensions `list` and `search` filter on, each a key of the taxonomy the catalog is
// validated against.
const FILTER_FLAGS = ['kind', 'domain', 'category', 'capability', 'problem', 'framework', 'language', 'lifecycle', 'risk', 'target', 'execution'];
const COMMAND_FLAGS = {
  help: [],
  version: ['json'],
  list: [...FILTER_FLAGS, 'json'],
  search: [...FILTER_FLAGS, 'json'],
  // `info` reads the catalog and nothing else. It accepted --target, --scope and --cwd and used
  // none of them, so a reader who named a target was answered about every target instead.
  info: ['json'],
  packs: ['json'],
  // `pack-info` reads --target for the hook fan-out; --scope and --cwd were accepted and ignored.
  'pack-info': ['target', 'json'],
  'verify-pack-evidence': ['report', 'json'],
  add: INSTALL_FLAGS,
  'add-pack': INSTALL_FLAGS,
  remove: REMOVE_FLAGS,
  'remove-pack': REMOVE_FLAGS,
  installed: ['target', 'scope', 'cwd', 'json'],
  doctor: ['target', 'scope', 'cwd', 'json'],
  'verify-integrity': ['json'],
  completion: [],
  validate: []
};

// The arguments each command reads, the command word excluded. A word beyond them is a typo or a
// quote that split, and reading none of it while exiting 0 is the same silent fallback a
// misspelled flag was: `info commit-guard garbage` described commit-guard and ignored the rest.
const COMMAND_ARGUMENTS = {
  help: 0,
  version: 0,
  list: 0,
  packs: 0,
  validate: 0,
  doctor: 0,
  installed: 0,
  info: 1,
  'pack-info': 1,
  'verify-pack-evidence': 1,
  add: 1,
  'add-pack': 1,
  remove: 1,
  'remove-pack': 1,
  'verify-integrity': 1,
  completion: 1,
  // `search` takes the terms themselves, so it is the one command with no fixed count.
  search: null
};

function assertKnownArguments(command, positional) {
  const allowed = COMMAND_ARGUMENTS[command];
  // A command added to COMMAND_FLAGS and not to this table would otherwise accept any number of
  // words, so a missing entry is reported rather than read as 'no limit'.
  if (allowed === undefined) throw new Error(`unknown command '${command}'`);
  if (allowed === null) return;
  const extra = positional.slice(1 + allowed);
  if (extra.length) {
    const expected = allowed === 0 ? 'takes no argument' : `takes ${allowed} argument`;
    throw new Error(`${command} ${expected}; unexpected: ${extra.join(', ')}`);
  }
}

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

// What each command's one argument names, for the generated shell completion and for nothing
// else: the completion cannot offer pack slugs where an artifact is expected unless it is told.
const ARGUMENT_COMPLETIONS = {
  add: 'artifacts',
  info: 'artifacts',
  remove: 'artifacts',
  'verify-integrity': 'artifacts',
  'add-pack': 'packs',
  'pack-info': 'packs',
  'remove-pack': 'packs',
  'verify-pack-evidence': 'packs',
  completion: 'shells'
};

// The fields `search` reads. The description is deliberately not among them: it is long enough
// that a common word would match most of the catalog, which is the same as matching nothing.
const SEARCH_FIELDS = ['name', 'slug', 'summary', 'refuses'];

// The subset `list`, `search` and `installed` emit with --json. It is a stable summary, not the
// manifest: catalog/artifacts.json carries every field, and this stays small enough to pipe.
function listRecord(manifest) {
  return {
    id: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    version: manifest.version,
    kind: manifest.kind,
    domain: manifest.domain,
    category: manifest.category,
    summary: manifest.summary,
    risk: manifest.risk,
    execution: manifest.execution.mode,
    lifecycle: manifest.lifecycle,
    targets: Object.keys(manifest.adapters).sort()
  };
}

function printListRow(manifest, suffix = '') {
  write(`${manifest.slug.padEnd(28)} ${manifest.kind.padEnd(9)} ${manifest.domain}/${manifest.category}${suffix}`);
  write(`  ${manifest.summary}`);
}

function applyFilters(records, options) {
  let kept = records;
  if (options.kind) kept = kept.filter(({ manifest }) => manifest.kind === options.kind);
  if (options.domain) kept = kept.filter(({ manifest }) => manifest.domain === options.domain);
  if (options.category) kept = kept.filter(({ manifest }) => manifest.category === options.category);
  if (options.capability) kept = kept.filter(({ manifest }) => manifest.capabilities.includes(options.capability));
  if (options.problem) kept = kept.filter(({ manifest }) => manifest.problems.includes(options.problem));
  if (options.framework) kept = kept.filter(({ manifest }) => manifest.frameworks.includes(options.framework));
  if (options.language) kept = kept.filter(({ manifest }) => manifest.languages.includes(options.language));
  if (options.lifecycle) kept = kept.filter(({ manifest }) => manifest.lifecycle.includes(options.lifecycle));
  if (options.risk) kept = kept.filter(({ manifest }) => manifest.risk === options.risk);
  if (options.target) kept = kept.filter(({ manifest }) => Object.hasOwn(manifest.adapters, options.target));
  if (options.execution) kept = kept.filter(({ manifest }) => manifest.execution.mode === options.execution);
  return kept;
}

// Every term must appear somewhere, and the rank is the number of distinct fields any term hit,
// so an artifact named after the term outranks one that only mentions it in a refusal.
function searchRecords(records, terms) {
  const needles = terms.map((term) => term.toLowerCase());
  const scored = [];
  for (const record of records) {
    const { manifest } = record;
    const haystack = {
      name: String(manifest.name).toLowerCase(),
      slug: String(manifest.slug).toLowerCase(),
      summary: String(manifest.summary).toLowerCase(),
      refuses: manifest.refuses.join('\n').toLowerCase()
    };
    if (!needles.every((needle) => SEARCH_FIELDS.some((field) => haystack[field].includes(needle)))) continue;
    const matched = SEARCH_FIELDS.filter((field) => needles.some((needle) => haystack[field].includes(needle)));
    scored.push({ record, matched });
  }
  return scored.sort((left, right) => right.matched.length - left.matched.length
    || left.record.manifest.id.localeCompare(right.record.manifest.id));
}

const COMPLETION_SHELLS = ['bash', 'zsh'];
// Flags that consume the next word. A completion that does not know them reads that word as the
// command: `--target codex add` would complete as if the command were `codex`.
const VALUE_FLAGS = [...new Set(['target', 'scope', 'cwd', 'report', ...FILTER_FLAGS])];

// The completion is generated from the same tables the parser uses, and from the catalog itself,
// so it cannot offer a command, a flag or a value the CLI would then refuse. zsh runs the bash
// definition through bashcompinit, so one definition serves both shells rather than two that
// could disagree.
function completionScript(shell) {
  if (!COMPLETION_SHELLS.includes(shell)) {
    throw new Error(`unknown shell '${shell}'; known shells: ${COMPLETION_SHELLS.join(', ')}`);
  }
  const taxonomy = loadTaxonomy(ROOT);
  const schemaFile = path.join(ROOT, 'schema', 'artifact.schema.json');
  const values = {
    target: taxonomy.targets,
    scope: taxonomy.scopes,
    kind: taxonomy.kinds,
    domain: Object.keys(taxonomy.domains),
    category: [...new Set(Object.values(taxonomy.domains).flat())].sort(),
    capability: taxonomy.capabilities,
    problem: taxonomy.problems,
    framework: taxonomy.frameworks,
    language: taxonomy.languages,
    lifecycle: taxonomy.lifecycle,
    risk: taxonomy.risk,
    execution: readJson(schemaFile).properties.execution.properties.mode.enum
  };
  const commands = Object.keys(COMMAND_FLAGS).sort();
  const artifacts = loadArtifacts(ROOT).map(({ manifest }) => manifest.slug).sort();
  const packs = loadPacks(ROOT).map(({ manifest }) => manifest.slug).sort();
  const words = (list) => [...list].join(' ');
  const lines = [];
  lines.push(`# youdede-toolkit completion for ${shell}, generated by \`youdede-toolkit completion ${shell}\`.`);
  lines.push(`# Load it with:  eval "$(youdede-toolkit completion ${shell})"`);
  if (shell === 'zsh') {
    lines.push('# zsh runs the bash definition below through bashcompinit.');
    lines.push('autoload -U +X bashcompinit && bashcompinit');
  }
  lines.push('_youdede_toolkit() {');
  lines.push('  local cur prev command skip i word');
  lines.push('  cur="${COMP_WORDS[COMP_CWORD]}"');
  lines.push('  prev="${COMP_WORDS[COMP_CWORD-1]}"');
  lines.push('  case "$prev" in');
  lines.push('    --cwd) COMPREPLY=($(compgen -d -- "$cur")); return;;');
  lines.push('    --report) COMPREPLY=($(compgen -f -- "$cur")); return;;');
  for (const flag of VALUE_FLAGS) {
    if (flag === 'cwd' || flag === 'report') continue;
    lines.push(`    --${flag}) COMPREPLY=($(compgen -W "${words(values[flag])}" -- "$cur")); return;;`);
  }
  lines.push('  esac');
  lines.push('  command=""');
  lines.push('  skip=0');
  lines.push('  for ((i=1; i<COMP_CWORD; i++)); do');
  lines.push('    word="${COMP_WORDS[i]}"');
  lines.push('    if [ "$skip" = "1" ]; then skip=0; continue; fi');
  lines.push('    case "$word" in');
  lines.push(`      ${VALUE_FLAGS.map((flag) => `--${flag}`).join('|')}) skip=1;;`);
  lines.push('      --*) ;;');
  lines.push('      *) if [ -z "$command" ]; then command="$word"; fi;;');
  lines.push('    esac');
  lines.push('  done');
  lines.push(`  if [ -z "$command" ]; then COMPREPLY=($(compgen -W "${words(commands)}" -- "$cur")); return; fi`);
  lines.push('  if [[ "$cur" == -* ]]; then');
  lines.push('    case "$command" in');
  for (const command of commands) {
    const flags = COMMAND_FLAGS[command].map((flag) => `--${flag}`);
    if (!flags.length) continue;
    lines.push(`      ${command}) COMPREPLY=($(compgen -W "${words(flags)}" -- "$cur"));;`);
  }
  lines.push('    esac');
  lines.push('    return');
  lines.push('  fi');
  lines.push('  case "$command" in');
  const byArgument = { artifacts, packs, shells: COMPLETION_SHELLS };
  for (const [name, list] of Object.entries(byArgument)) {
    const matching = Object.entries(ARGUMENT_COMPLETIONS).filter(([, kind]) => kind === name).map(([command]) => command);
    if (!matching.length) continue;
    lines.push(`    ${matching.sort().join('|')}) COMPREPLY=($(compgen -W "${words(list)}" -- "$cur"));;`);
  }
  lines.push('  esac');
  lines.push('}');
  lines.push('complete -F _youdede_toolkit youdede-toolkit');
  return `${lines.join('\n')}\n`;
}

// A filter value that matches nothing reads exactly like a filter value that does not exist:
// `list --kind hooks` printed `0 artifact(s).` and exited 0, so a typo in a script reported an
// empty catalog instead of refusing. Values are checked against the same taxonomy every artifact
// is validated against, so a value this accepts is one the catalog could carry.
function assertKnownFilters(options) {
  const taxonomy = loadTaxonomy(ROOT);
  const TAXONOMY = 'catalog/taxonomy.json';
  const schemaFile = 'schema/artifact.schema.json';
  const executionModes = readJson(path.join(ROOT, ...schemaFile.split('/'))).properties.execution.properties.mode.enum;
  const known = {
    kind: ['kinds', taxonomy.kinds, TAXONOMY],
    domain: ['domains', Object.keys(taxonomy.domains), TAXONOMY],
    category: ['categories', [...new Set(Object.values(taxonomy.domains).flat())], TAXONOMY],
    capability: ['capabilities', taxonomy.capabilities, TAXONOMY],
    problem: ['problems', taxonomy.problems, TAXONOMY],
    framework: ['frameworks', taxonomy.frameworks, TAXONOMY],
    language: ['languages', taxonomy.languages, TAXONOMY],
    lifecycle: ['lifecycle stages', taxonomy.lifecycle, TAXONOMY],
    risk: ['risk levels', taxonomy.risk, TAXONOMY],
    target: ['targets', taxonomy.targets, TAXONOMY],
    execution: ['execution modes', executionModes, schemaFile]
  };
  for (const [flag, [label, values, source]] of Object.entries(known)) {
    const value = options[flag];
    if (value === undefined || values.includes(value)) continue;
    const detail = values.length <= 12
      ? `known ${label}: ${[...values].sort().join(', ')}`
      : `the ${values.length} known ${label} are listed in ${source}`;
    throw new Error(`unknown ${flag} '${value}'; ${detail}`);
  }
}

// A prompt is shown only when a person is at the terminal: an agent, CI, or a pipe gets notices.
const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
async function ask(question, defaultYes) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = parseAnswer(await terminal.question(attempt ? 'Please answer y or n: ' : question), defaultYes);
      if (answer !== null) return answer;
    }
    return defaultYes;
  } finally {
    terminal.close();
  }
}
const slugOf = (id) => id.split('/').at(-1);
const write = (line) => process.stdout.write(`${line}\n`);
const notify = (line) => process.stderr.write(`${line}\n`);

function help() {
  const targets = SUPPORTED_TARGETS.join('|');
  const placement = `[--target ${targets}] [--scope project|user] [--cwd path]`;
  const filters = '[--kind value] [--domain value] [--category value] [--capability value] [--problem value]';
  const moreFilters = '[--framework value] [--language value] [--lifecycle value] [--risk value] [--target value] [--execution value]';
  process.stdout.write(`youdede-toolkit\n\n`);
  process.stdout.write(`  list ${filters} [--json]\n`);
  process.stdout.write(`       ${moreFilters}\n`);
  process.stdout.write(`  search <term...> [the same filters as list] [--json]\n`);
  process.stdout.write(`  info <id-or-slug> [--json]\n`);
  process.stdout.write(`  packs [--json]\n`);
  process.stdout.write(`  pack-info <id-or-slug> [--target ${targets}] [--json]\n`);
  process.stdout.write(`  verify-pack-evidence <id-or-slug> --report path [--json]\n`);
  process.stdout.write(`  add <id-or-slug> ${placement} [--dry-run] [--json] [--force] [--no-prerequisites]\n`);
  process.stdout.write(`  add-pack <id-or-slug> ${placement} [--dry-run] [--json] [--force] [--no-prerequisites]\n`);
  process.stdout.write(`  remove <id-or-slug> ${placement} [--dry-run] [--json] [--force]\n`);
  process.stdout.write(`  remove-pack <id-or-slug> ${placement} [--dry-run] [--json] [--force]\n`);
  process.stdout.write(`  installed ${placement} [--json]\n`);
  process.stdout.write(`  doctor ${placement} [--json]\n`);
  process.stdout.write(`  verify-integrity [id-or-slug] [--json]\n`);
  process.stdout.write(`  completion ${COMPLETION_SHELLS.join('|')}\n`);
  process.stdout.write(`  version [--json]\n`);
  process.stdout.write(`  validate\n`);
  process.stdout.write(`\nEvery command exits 0 when it answered and 1 when it refused or failed.\n`);
}

function printVersion(options) {
  const { name, version } = readJson(path.join(ROOT, 'package.json'));
  if (options.json) write(JSON.stringify({ name, version }, null, 2));
  else write(`${name} ${version}`);
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
  // `--version` with no command used to be read as an option expecting a value and exited 1.
  if (options.version) return printVersion(options);
  if (!command || options.help || command === 'help') return help();
  assertKnownFlags(command, options);
  assertKnownArguments(command, positional);
  // A --cwd that is not a directory used to be answered as an empty workspace: `doctor` found no
  // drift and `add --dry-run` planned writes under a path that does not exist.
  if (options.cwd !== undefined) {
    let stats = null;
    try { stats = statSync(options.cwd); } catch {}
    if (!stats) throw new Error(`--cwd '${options.cwd}' does not exist`);
    if (!stats.isDirectory()) throw new Error(`--cwd '${options.cwd}' is not a directory`);
  }

  if (command === 'version') return printVersion(options);

  if (command === 'completion') {
    process.stdout.write(completionScript(requireQuery(positional)));
    return;
  }

  if (command === 'list') {
    assertKnownFilters(options);
    const records = applyFilters(loadArtifacts(ROOT), options)
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
    if (options.json) {
      write(JSON.stringify({ count: records.length, artifacts: records.map(({ manifest }) => listRecord(manifest)) }, null, 2));
      return;
    }
    for (const { manifest } of records) printListRow(manifest);
    write(`\n${records.length} artifact(s).`);
    return;
  }

  if (command === 'search') {
    const terms = positional.slice(1).filter((term) => term.length > 0);
    if (terms.length === 0) throw new Error('search requires at least one term');
    assertKnownFilters(options);
    const results = searchRecords(applyFilters(loadArtifacts(ROOT), options), terms);
    if (options.json) {
      write(JSON.stringify({
        terms,
        count: results.length,
        results: results.map(({ record, matched }) => ({ ...listRecord(record.manifest), matchedFields: matched }))
      }, null, 2));
      return;
    }
    for (const { record, matched } of results) printListRow(record.manifest, `  [${matched.join(', ')}]`);
    write(`\n${results.length} artifact(s) matching ${terms.map((term) => `'${term}'`).join(' and ')}.`);
    return;
  }

  if (command === 'info') {
    const { manifest, directory, adapters } = resolveArtifact(requireQuery(positional));
    const integrityCatalog = readIntegrityManifest(ROOT);
    const integrity = integrityCatalog.artifacts.find(({ artifactId }) => artifactId === manifest.id);
    const compatibility = Object.keys(adapters).sort().map((target) => ({
      target,
      stability: adapters[target].data.stability || 'stable',
      scopes: adapters[target].data.scopes,
      limitations: adapters[target].data.limitations || []
    }));
    if (options.json) {
      write(JSON.stringify({
        ...listRecord(manifest),
        description: manifest.description,
        authors: manifest.authors,
        integrity: integrity ? integrity.integrityId : null,
        problems: manifest.problems,
        capabilities: manifest.capabilities,
        frameworks: manifest.frameworks,
        languages: manifest.languages,
        risk_reason: manifest.risk_reason,
        operational: manifest.operational,
        refuses: manifest.refuses,
        packs: manifest.relationships.packIds,
        targetCompatibility: compatibility,
        sourceDirectory: path.relative(ROOT, directory)
      }, null, 2));
      return;
    }
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
    for (const entry of compatibility) {
      const limitations = entry.limitations.length ? `; limitations: ${entry.limitations.join(' | ')}` : '';
      process.stdout.write(`- ${entry.target} (${entry.stability}; scopes: ${entry.scopes.join(', ')})${limitations}\n`);
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
    const packs = loadPacks(ROOT).sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    if (options.json) {
      write(JSON.stringify({
        count: packs.length,
        packs: packs.map(({ manifest }) => ({
          id: manifest.id,
          slug: manifest.slug,
          name: manifest.name,
          version: manifest.version,
          summary: manifest.summary,
          memberCount: manifest.members.length
        }))
      }, null, 2));
      return;
    }
    for (const { manifest } of packs) {
      process.stdout.write(`${manifest.slug.padEnd(32)} ${manifest.members.length} members\n  ${manifest.summary}\n`);
    }
    process.stdout.write(`\n${packs.length} pack(s).\n`);
    return;
  }

  if (command === 'pack-info') {
    // An unknown --target was answered as if it named no hook adapter at all, and exited 0.
    assertKnownFilters(options);
    const { manifest } = resolvePack(requireQuery(positional));
    const target = options.target || DEFAULT_TARGET;
    // A required member without an adapter for the target makes `add-pack` refuse there, so the
    // answer says so instead of reading as installable. Catalog data only, like the fan-out.
    const blockers = manifest.members.filter((member) => {
      if (!member.required) return false;
      try { return !resolveArtifact(member.artifactId).adapters[target]; } catch { return true; }
    }).map((member) => member.artifactId);
    if (options.json) {
      const result = {
        id: manifest.id,
        slug: manifest.slug,
        name: manifest.name,
        version: manifest.version,
        summary: manifest.summary,
        outcomes: manifest.outcomes,
        members: manifest.members.map(({ artifactId, role, required }) => ({ artifactId, role, required })),
        // The same targets catalog/packs.json lists for the pack.
        targets: analyzePackWorkflow(manifest, loadArtifacts(ROOT)).compatibility.map((entry) => entry.target)
      };
      if (options.target) Object.assign(result, { target, installable: blockers.length === 0, blockingMembers: blockers });
      write(JSON.stringify(result, null, 2));
      return;
    }
    process.stdout.write(`${manifest.name} ${manifest.version}\n${manifest.id}\n\n${manifest.summary}\n\nOutcomes: ${manifest.outcomes.join(', ')}\nEvidence: ledger-linked; schema ${manifest.evidence.reportSchema}\nMembers:\n`);
    for (const member of manifest.members) process.stdout.write(`- ${member.artifactId} (${member.role}${member.required ? ', required' : ', optional'})\n`);
    // Fan-out is catalog data. Deriving it from an install plan made a read-only query depend on
    // the working directory and fail on unrelated workspace state, and made `pack-info` stat and
    // hash files under the user's config root as a side effect.
    const fanout = new Map();
    const prerequisites = prerequisiteMembers(manifest, (id) => { try { return resolveArtifact(id); } catch { return null; } });
    for (const member of manifest.members) {
      let record = null;
      try { record = resolveArtifact(member.artifactId); } catch { continue; }
      if (record.manifest.kind !== 'hook' || prerequisites.has(member.artifactId)) continue;
      const adapter = record.adapters[target]?.data;
      if (!adapter) continue;
      for (const binding of hookBindings(adapter)) {
        const boundary = `${binding.event}:${binding.matcher}`;
        fanout.set(boundary, (fanout.get(boundary) || 0) + 1);
      }
    }
    const extra = prerequisites.size ? ` (plus ${prerequisites.size === 1 ? 'prerequisite' : 'prerequisites'}: ${[...prerequisites].map((id) => id.split('/').at(-1)).join(', ')})` : '';
    if (fanout.size) process.stdout.write(`Hook fan-out: ${[...fanout].sort((a, b) => b[1] - a[1]).map(([boundary, count]) => `${boundary}=${count}`).join(', ')}${extra}\n`);
    if (blockers.length) process.stdout.write(`Not installable on ${target}: required ${blockers.length === 1 ? 'member' : 'members'} without a ${target} adapter: ${blockers.join(', ')}\n`);
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
        // A prerequisite is listed with the files it writes, which the real install writes as well.
        for (const id of result.prerequisites) {
          process.stdout.write(`Would ${options['no-prerequisites'] ? 'skip' : 'install'} prerequisite ${id}\n`);
          if (options['no-prerequisites']) continue;
          const prerequisite = planArtifactInstall(id, { target: options.target, scope: options.scope, cwd: options.cwd, force: options.force });
          for (const file of prerequisite.writes) process.stdout.write(`- ${file.action} ${file.path} (${file.bytes} bytes, sha256 ${file.sha256})\n`);
        }
        process.stdout.write(`Would install ${result.artifact.id} in ${result.configRoot}\n`);
        if (result.integrity) process.stdout.write(`Verified ${result.integrity.integrityId}\n`);
        for (const file of result.writes) process.stdout.write(`- ${file.action} ${file.path} (${file.bytes} bytes, sha256 ${file.sha256})\n`);
        for (const file of result.removes) process.stdout.write(`- ${file.action} ${file.path}\n`);
        if (result.settings) process.stdout.write(`- ${result.settings.action} ${result.settings.path}\n`);
        if (result.mcpConfig) process.stdout.write(`- ${result.mcpConfig.action} ${result.mcpConfig.path}: ${result.mcpConfig.servers.join(', ')}\n`);
        process.stdout.write(`- update ${result.state.path}\n`);
        process.stdout.write(`- ${result.notice.action} ${result.notice.path}\n`);
        printRuntimeDisclosure(result.runtime);
        for (const warning of result.warnings || []) process.stdout.write(`Warning: ${warning}\n`);
      }
      return;
    }
    const query = requireQuery(positional);
    const placement = { target: options.target, scope: options.scope, cwd: options.cwd, force: options.force };
    // Ask (or notify) once before installing the missing prerequisites, with the reason of each link. A
    // plan that fails is left to the install, which reports the same error before anything is asked.
    let planned = null;
    try { planned = planArtifactInstall(query, placement); } catch {}
    const reasonOf = (id) => planned?.prerequisiteReasons?.[id] ?? null;
    // With --json, stdout carries only the result: no question is asked and notices go to stderr.
    const prompting = interactive() && !options.json;
    const asking = prompting && !options['no-prerequisites'];
    const prerequisites = await decidePrerequisites({
      subject: planned?.artifact.slug ?? query,
      prerequisites: (planned?.prerequisites ?? []).map((id) => ({ slug: slugOf(id), reason: reasonOf(id) })),
      interactive: prompting,
      skip: Boolean(options['no-prerequisites']),
      ask,
      write: options.json ? notify : write
    });
    const result = installArtifact(query, { ...placement, prerequisites });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        artifact: result.artifact.id,
        configRoot: result.configRoot,
        prerequisites: result.prerequisites.map((manifest) => manifest.id),
        skippedPrerequisites: result.skippedPrerequisites.map((manifest) => manifest.id),
        files: result.files,
        settingsFile: result.settingsFile,
        mcpConfigFile: result.mcpConfigFile,
        integrity: result.integrity,
        runtime: result.runtime,
        warnings: result.warnings || []
      }, null, 2)}\n`);
      return;
    }
    for (const manifest of result.prerequisites) process.stdout.write(`Installed prerequisite ${manifest.slug}.\n`);
    process.stdout.write(`Installed ${result.artifact.id} in ${result.configRoot}\n`);
    if (result.skippedPrerequisites.length) {
      write(skippedNotice(result.artifact.slug, result.skippedPrerequisites.map((manifest) => ({ slug: manifest.slug, reason: reasonOf(manifest.id) })), { asked: asking }));
    }
    for (const file of result.files) process.stdout.write(`- ${file}\n`);
    if (result.settingsFile) process.stdout.write(`- merged ${result.settingsFile}\n`);
    if (result.mcpConfigFile) process.stdout.write(`- merged ${result.mcpConfigFile}\n`);
    if (result.integrity) process.stdout.write(`- verified ${result.integrity.integrityId}\n`);
    printRuntimeDisclosure(result.runtime);
    for (const warning of result.warnings || []) process.stdout.write(`Warning: ${warning}\n`);
    const hint = suggestionHint(suggestionsFor([result.artifact.id, ...result.prerequisites.map((manifest) => manifest.id)], placement));
    if (hint) write(hint);
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
    // The prerequisites members need that the pack does not contain: asked once for the pack.
    const query = requireQuery(positional);
    const planned = planPackInstall(query, installOptions);
    const members = new Set(planned.members.map((item) => item.member.artifactId));
    const reasons = new Map();
    for (const item of planned.members) for (const [id, reason] of Object.entries(item.plan?.prerequisiteReasons ?? {})) if (!reasons.has(id)) reasons.set(id, reason);
    const outside = [...reasons.keys()].filter((id) => !members.has(id));
    const subject = `the ${planned.pack.slug} pack`;
    const prerequisites = await decidePrerequisites({
      subject,
      prerequisites: outside.map((id) => ({ slug: slugOf(id), reason: reasons.get(id) })),
      interactive: interactive() && !options.json,
      skip: Boolean(options['no-prerequisites']),
      ask,
      write: options.json ? notify : write
    });
    const result = installPack(query, { ...installOptions, prerequisites });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        pack: result.pack.id,
        target: result.target,
        scope: result.scope,
        installed: result.installed.map((item) => ({ artifact: item.artifact.id, prerequisites: (item.prerequisites ?? []).map((manifest) => manifest.id), files: item.files })),
        skipped: result.skipped.map((item) => ({ artifact: item.member.artifactId, reason: item.skipped }))
      }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Installed ${result.pack.id} for ${result.target}/${result.scope}\n`);
    for (const item of result.installed) {
      for (const manifest of item.prerequisites ?? []) process.stdout.write(`- ${manifest.id} (prerequisite)\n`);
      process.stdout.write(`- ${item.artifact.id}\n`);
    }
    const skipped = [...new Set(result.installed.flatMap((item) => (item.skippedPrerequisites ?? []).map((manifest) => manifest.id)))].filter((id) => !members.has(id));
    if (skipped.length) write(skippedNotice(subject, skipped.map((id) => ({ slug: slugOf(id), reason: reasons.get(id) ?? null })), { asked: interactive() && !options['no-prerequisites'] }));
    for (const item of result.skipped) process.stdout.write(`- skipped ${item.member.artifactId}: ${item.skipped}\n`);
    const installedIds = result.installed.flatMap((item) => [item.artifact.id, ...(item.prerequisites ?? []).map((manifest) => manifest.id)]);
    const hint = suggestionHint(suggestionsFor(installedIds, { ...installOptions, exclude: [...members] }));
    if (hint) write(hint);
    return;
  }

  if (command === 'remove') {
    const query = requireQuery(positional);
    const placement = { target: options.target, scope: options.scope, cwd: options.cwd, force: options.force };
    // A dry run reports the dependents instead of refusing over them: the point of it is to show
    // the whole consequence, including that the real removal would ask first, or refuse outside a
    // terminal. Every other refusal above it still applies, so a plan it cannot produce is an error.
    if (options['dry-run']) {
      const dependents = options.force ? [] : installedDependentsOf(query, placement);
      const plan = planArtifactRemoval(query, { ...placement, confirmedDependents: true });
      if (options.json) {
        write(JSON.stringify({ ...plan, artifact: plan.artifact.id, dependents: dependents.map(({ slug }) => slug) }, null, 2));
        return;
      }
      if (plan.ownershipReleased) {
        write(`Would release the '${plan.ownershipReleased}' claim on ${plan.artifact.id} in ${plan.configRoot}, removing no files`);
      } else {
        write(`Would remove ${plan.artifact.id} from ${plan.configRoot}`);
      }
      for (const file of plan.removes) write(`- ${file.action} ${file.path}`);
      if (plan.settings) write(`- ${plan.settings.action} ${plan.settings.path}`);
      if (plan.mcpConfig) write(`- ${plan.mcpConfig.action} ${plan.mcpConfig.path}: ${plan.mcpConfig.servers.join(', ')}`);
      write(`- ${plan.state.action} ${plan.state.path}`);
      if (plan.notice && plan.notice.action !== 'none') write(`- ${plan.notice.action} ${plan.notice.path}`);
      if (dependents.length) {
        write(neededByMessage(slugOf(plan.artifact.id), dependents.map(({ slug }) => slug)));
      }
      return;
    }
    // Removing a prerequisite that installed artifacts require: asked in a terminal (default no);
    // elsewhere the removal refuses unless --force. Suggested and related links never block.
    let confirmedDependents = false;
    const dependents = options.force ? [] : installedDependentsOf(query, placement);
    const prompting = interactive() && !options.json;
    if (dependents.length && !prompting) {
      process.stderr.write(`${neededByMessage(slugOf(resolveArtifact(query).manifest.id), dependents.map(({ slug }) => slug))}\n`);
      process.exitCode = 1;
      return;
    }
    if (dependents.length) {
      confirmedDependents = await confirmRemoval({ prerequisite: slugOf(resolveArtifact(query).manifest.id), dependents, interactive: true, ask });
      if (!confirmedDependents) {
        write(`Kept ${query}.`);
        return;
      }
    }
    const result = removeArtifact(query, { ...placement, confirmedDependents });
    if (options.json) {
      write(JSON.stringify({
        artifact: result.artifact.id,
        configRoot: result.configRoot,
        removed: result.removed,
        ownershipReleased: result.ownershipReleased ?? null
      }, null, 2));
      return;
    }
    process.stdout.write(`Removed ${result.artifact.id} from ${result.configRoot}\n`);
    return;
  }

  if (command === 'remove-pack') {
    const query = requireQuery(positional);
    const placement = { target: options.target, scope: options.scope, cwd: options.cwd, force: options.force };
    if (options['dry-run']) {
      const plan = planPackRemoval(query, placement);
      if (options.json) {
        write(JSON.stringify({ ...plan, pack: plan.pack.id }, null, 2));
        return;
      }
      write(`Would remove ${plan.pack.id} for ${plan.target}/${plan.scope}`);
      for (const member of plan.members) {
        write(`- ${member.artifact}${member.ownershipReleased ? ' (release claim only)' : ''}`);
        for (const file of member.removes) write(`  - ${file.action} ${file.path}`);
        if (member.settings) write(`  - ${member.settings.action} ${member.settings.path}`);
        if (member.mcpConfig) write(`  - ${member.mcpConfig.action} ${member.mcpConfig.path}: ${member.mcpConfig.servers.join(', ')}`);
      }
      for (const root of plan.roots) {
        write(`- ${root.state.action} ${root.state.path}`);
        if (root.notice.action !== 'none') write(`- ${root.notice.action} ${root.notice.path}`);
      }
      if (plan.dependents.length) write(`Blocked: still needed by ${plan.dependents.join(', ')}. Remove those first, or use --force.`);
      return;
    }
    const result = removePack(query, placement);
    if (options.json) {
      write(JSON.stringify({
        pack: result.pack.id,
        target: result.target,
        scope: result.scope,
        removed: result.removed.map((item) => ({ artifact: item.artifact.id, removed: item.removed }))
      }, null, 2));
      return;
    }
    process.stdout.write(`Removed ${result.pack.id} for ${result.target}/${result.scope}\n`);
    return;
  }

  if (command === 'installed') {
    const result = listInstalled({ target: options.target, scope: options.scope, cwd: options.cwd });
    if (options.json) {
      write(JSON.stringify(result, null, 2));
      return;
    }
    for (const install of result.installs) {
      const owners = install.owners.join(', ');
      write(`${String(install.slug || install.artifactId).padEnd(28)} ${String(install.kind).padEnd(9)} ${install.version || 'unknown'}  [${owners}]`);
      write(`  ${install.artifactId}`);
    }
    write(`\n${result.installs.length} installed for ${result.target}/${result.scope}.`);
    return;
  }

  if (command === 'doctor') {
    const result = doctor({ target: options.target, scope: options.scope, cwd: options.cwd });
    if (options.json) {
      write(JSON.stringify(result, null, 2));
      if (result.findings.length) process.exitCode = 1;
      return;
    }
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
    const { artifacts, results, packs, packResults, repositoryErrors } = validateRepository();
    const errors = results.flatMap(({ record, errors: found }) => found.map((error) => `${record.manifest.id}: ${error}`));
    errors.push(...packResults.flatMap(({ record, errors: found }) => found.map((error) => `${record.manifest.id}: ${error}`)));
    errors.push(...repositoryErrors);
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
