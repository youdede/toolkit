#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Records the verdict (exit code, rule id, stdout decision) of every Claude Code hook for every
// corpus entry in quality/hook-verdicts.json, running each hook as a real process from a staged
// install layout, inside a fresh deterministic fixture. The snapshot is the corpus: new entries are
// added without verdict fields (a hook result without `expected`) and this script fills them. An entry whose verdict differs from the
// recorded one fails unless it carries a `change` object (reason, finding); the new verdict is then
// written into `change`, so the recorded `exit`/`ruleId` stay the baseline. See
// docs/deterministic-components.md.

import { fork, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, rm } from 'node:fs/promises';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandSnapshot, serializeCompactSnapshot } from './lib/hook-verdict-format.mjs';
import { ADAPTERS, testsProcess } from './lib/hook-verdict-inline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT = path.join(ROOT, 'quality', 'hook-verdicts.json');
const HOOK_TIMEOUT_MS = 30000;
const FIXED_DATE = '2026-01-01T00:00:00Z';

// Fixture secrets are assembled at run time so no contiguous credential lives in the repository.
const TOKENS = {
  AWS_ACCESS_KEY: ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
  AWS_SECRET_KEY: ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/'),
  GITHUB_TOKEN: ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890AB'].join('_'),
  ANTHROPIC_KEY: ['sk', 'ant', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('-'),
  OPENAI_KEY: ['sk', 'proj', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'].join('-'),
  SLACK_TOKEN: ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnopqrstuvwx'].join('-'),
  STRIPE_KEY: ['sk', 'live', 'ABCDEFGHIJKLMNOPQRSTUVWX'].join('_'),
  PRIVATE_KEY_HEADER: ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ')
};

export function expand(value, places) {
  if (typeof value === 'string') {
    return value
      .replace(/\{\{repeat:(.):(\d+)\}\}/g, (_, char, count) => char.repeat(Number(count)))
      .replace(/\{\{([A-Za-z_]+)\}\}/g, (match, name) => {
        if (name in places) return places[name];
        if (name in TOKENS) return TOKENS[name];
        throw new Error(`unknown token ${match}`);
      });
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, places));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, places)]));
  return value;
}

export function listHooks() {
  const hooks = new Map();
  const walk = (directory, depth) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const next = path.join(directory, entry.name);
      if (depth < 2) walk(next, depth + 1);
      else hooks.set(entry.name, next);
    }
  };
  walk(path.join(ROOT, 'artifacts', 'hooks'), 0);
  return hooks;
}

// Copies every file of the Claude Code adapter to its installed location, so hooks find their
// companions (lib/session-ledger.mjs, mcp-pins.json, test-integrity-paths.mjs) as in a real install.
export function stageHooks(stage) {
  const scripts = {};
  for (const [slug, directory] of listHooks()) {
    const adapter = JSON.parse(readFileSync(path.join(directory, 'adapters', 'claude-code.json'), 'utf8'));
    for (const file of adapter.files) {
      const source = file.root === 'package' ? path.join(ROOT, file.from) : path.join(directory, file.from);
      const target = path.join(stage, file.to);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    scripts[slug] = path.join(stage, adapter.files[0].to);
  }
  return scripts;
}

function cleanEnvironment(extra) {
  const env = {};
  for (const key of ['PATH', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP', 'LANG']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

function fixtureGit(repo, home, args) {
  const env = cleanEnvironment({
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'youdede tests',
    GIT_AUTHOR_EMAIL: 'tests@youdede.invalid',
    GIT_COMMITTER_NAME: 'youdede tests',
    GIT_COMMITTER_EMAIL: 'tests@youdede.invalid',
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_DATE: FIXED_DATE
  });
  const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr.trim()}`);
}

// Fixture steps run in order inside <root>/repo; relative paths resolve against the repo.
export function buildFixture(root, steps) {
  const places = { root, repo: path.join(root, 'repo'), home: path.join(root, 'home') };
  for (const directory of [places.repo, places.home]) mkdirSync(directory, { recursive: true });
  const at = (target) => path.resolve(places.repo, target);
  for (const raw of steps) {
    const [op, ...args] = expand(raw, places);
    if (op === 'write') {
      mkdirSync(path.dirname(at(args[0])), { recursive: true });
      writeFileSync(at(args[0]), args[1]);
    } else if (op === 'mkdir') mkdirSync(at(args[0]), { recursive: true });
    else if (op === 'rm') rmSync(at(args[0]), { recursive: true, force: true });
    else if (op === 'symlink') {
      mkdirSync(path.dirname(at(args[1])), { recursive: true });
      symlinkSync(args[0], at(args[1]));
    } else if (op === 'chmod') chmodSync(at(args[1]), Number.parseInt(args[0], 8));
    else if (op === 'git') fixtureGit(places.repo, places.home, args);
    else if (op === 'repo') {
      fixtureGit(places.repo, places.home, ['init', '-q', '-b', args[0] || 'main']);
      writeFileSync(at('README.md'), 'baseline\n');
      fixtureGit(places.repo, places.home, ['add', 'README.md']);
      fixtureGit(places.repo, places.home, ['commit', '-qm', 'baseline']);
    } else if (op === 'remote') {
      // Bare remote "origin" at <root>/remote.git with the current branch pushed and tracked.
      fixtureGit(root, places.home, ['init', '-q', '--bare', '-b', 'main', 'remote.git']);
      fixtureGit(places.repo, places.home, ['remote', 'add', 'origin', path.join(root, 'remote.git')]);
      fixtureGit(places.repo, places.home, ['push', '-q', '-u', 'origin', 'HEAD']);
    } else throw new Error(`unknown fixture step ${op}`);
  }
  return places;
}

function summarizeStdout(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return 'text';
  }
  if (!value || typeof value !== 'object') return 'json';
  const parts = [];
  for (const [key, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [inner, innerItem] of Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) {
        parts.push(/decision$/i.test(inner) ? `${key}.${inner}=${innerItem}` : `${key}.${inner}`);
      }
    } else parts.push(/decision$|^continue$/i.test(key) ? `${key}=${item}` : key);
  }
  return parts.join(',');
}

// Hooks print "[rule-id]"; the few that block without one (commit-guard findings, policy-file-guard)
// are identified by their normalized first detail line instead.
function ruleIdFrom(stderr, stdout, roots) {
  const match = /\[([a-z0-9][a-z0-9-]*)\]/.exec(stderr) || /\[([a-z0-9][a-z0-9-]*)\]/.exec(stdout);
  if (match) return match[1];
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const detail = /^BLOCKED by [a-z0-9-]+:$/.test(lines[0]) && lines[1] ? lines[1] : lines[0];
  return `text:${roots.reduce((text, root) => text.split(root).join('<root>'), detail).slice(0, 120)}`;
}

// Each fixture is built once as a template and copied per entry, so every hook run starts from the
// same state and hook side effects (ledgers, receipts) never leak between entries. Absolute paths
// written by fixture steps point into the template, which stays in place for the whole run.
async function instantiate(name, fixtures, workRoot, root, templates) {
  if (!templates.has(name)) {
    const steps = fixtures[name];
    if (!steps) throw new Error(`unknown fixture ${name}`);
    const template = path.join(workRoot, 'templates', String(templates.size));
    buildFixture(template, steps);
    templates.set(name, template);
  }
  const template = templates.get(name);
  await cp(template, root, { recursive: true, verbatimSymlinks: true });
  return { template, places: { root, repo: path.join(root, 'repo'), home: path.join(root, 'home') } };
}

function runProcess(script, stdin, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), HOOK_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exit: signal ? `signal:${signal}` : code });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

// A long-lived worker process that runs cases in process (lib/hook-verdict-inline.mjs). `run`
// resolves to null when the case must run as a process instead: the hook threw, or it took longer
// than a hook process may (the worker is then replaced).
const WORKER = fileURLToPath(new URL('./lib/hook-verdict-inline.mjs', import.meta.url));
let workerCount = 0;
function inlineWorker() {
  const id = `w${workerCount++}`;
  const copies = new Map();
  let child = null;
  let next = 0;
  const waiting = new Map();
  const start = () => {
    const current = fork(WORKER, ['--hook-verdict-worker'], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    current.on('message', (message) => {
      const done = waiting.get(message.id);
      waiting.delete(message.id);
      done?.(message.fallback === undefined ? message : null);
    });
    current.on('exit', () => {
      if (child === current) child = null;
      for (const done of waiting.values()) done(null);
      waiting.clear();
    });
    child = current;
  };
  return {
    id,
    copies,
    run(job) {
      if (!child) start();
      const id = next++;
      const current = child;
      return new Promise((resolve) => {
        const timer = setTimeout(() => current.kill('SIGKILL'), HOOK_TIMEOUT_MS);
        waiting.set(id, (value) => { clearTimeout(timer); resolve(value); });
        current.send({ id, ...job });
      });
    },
    close: () => child?.kill()
  };
}

// Runs one case: as a hook process in a fresh copy of its fixture, or in process through `worker`
// in the worker's own copy, which its later cases of that fixture reuse. A hook with an adapter
// writes no file (the ones that do run as processes); Git may refresh the index, which changes no
// verdict, and the parity sample runs its cases in fresh copies. Returns null when the worker hands
// the case back.
async function runOne(script, entry, fixtures, workRoot, key, templates, worker) {
  const name = entry.fixture || 'empty';
  const copies = worker?.copies;
  const root = copies ? path.join(workRoot, 'runs', `${worker.id}-${copies.get(name)?.number ?? copies.size}`) : path.join(workRoot, 'runs', key);
  let places;
  let template;
  try {
    if (copies?.has(name)) ({ places, template } = copies.get(name));
    else {
      ({ places, template } = await instantiate(name, fixtures, workRoot, root, templates));
      copies?.set(name, { places, template, number: copies.size });
    }
  } catch (error) {
    return { error: error.message };
  }
  let stdin;
  if (typeof entry.raw === 'string') stdin = expand(entry.raw, places);
  else {
    const input = expand(entry.input, places);
    if (input && typeof input === 'object' && !Array.isArray(input) && !('cwd' in input)) input.cwd = places.repo;
    stdin = JSON.stringify(input);
  }
  const env = cleanEnvironment({ HOME: places.home, ...expand(entry.env || {}, places) });
  const ran = worker ? await worker.run({ hook: entry.hook, script, stdin, env, cwd: places.repo }) : await runProcess(script, stdin, env, places.repo);
  const verdict = ran && { exit: ran.exit, ruleId: ruleIdFrom(ran.stderr, ran.stdout, [root, template]), output: summarizeStdout(ran.stdout) };
  if (!copies) await rm(root, { recursive: true, force: true }).catch(() => {});
  return verdict;
}

// How computeVerdicts runs the cases (planCases). `processes`: every case as a hook process (the recorder, and
// `--check --processes` for release checks). `mixed`: in process where the hook has an adapter,
// except the cases about the process itself and the first other case of each hook, which keeps
// every payload's entrypoint exercised. `inline`: in process wherever possible. With `parity`,
// every 20th case that can run in process and each hook's first such case run both ways, and
// `parity` lists both verdicts.
export const PARITY_STEP = 20;
export function planCases(entries, { mode = 'processes', parity = false } = {}) {
  const inlineable = (entry) => Boolean(ADAPTERS[entry.hook]) && !testsProcess(entry);
  const first = new Set();
  const seen = new Set();
  entries.forEach((entry, index) => {
    if (!inlineable(entry) || seen.has(entry.hook)) return;
    first.add(index);
    seen.add(entry.hook);
  });
  return {
    inline: entries.map((entry, index) => mode !== 'processes' && inlineable(entry) && !(mode === 'mixed' && first.has(index))),
    twice: entries.map((entry, index) => parity && inlineable(entry) && (index % PARITY_STEP === 0 || first.has(index)))
  };
}

// Hook processes keep their default of one per core. In-process workers run one per core but one (at
// least one), so the timing tests that npm test runs beside them keep a core.
const CORES = os.availableParallelism?.() ?? os.cpus().length;
export const defaultConcurrency = (mode) => (mode === 'processes' ? Math.max(2, CORES) : Math.max(1, CORES - 1));
export async function computeVerdicts(document, { mode = 'processes', concurrency = defaultConcurrency(mode), parity = false } = {}) {
  const { entries } = document;
  const plan = planCases(entries, { mode, parity });
  const inline = (index) => plan.inline[index];
  const twice = (index) => plan.twice[index];
  // Canonical path: some hooks only start when argv[1] equals their canonical URL, so a symlinked
  // temp dir (macOS /var) would turn them into no-ops. Entries with via "symlink" exercise that path.
  const workRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'youdede-hook-verdicts-')));
  const workers = [];
  try {
    const scripts = stageHooks(path.join(workRoot, 'stage'));
    symlinkSync(path.join(workRoot, 'stage'), path.join(workRoot, 'stage-link'));
    const fixtures = { empty: [], ...document.fixtures };
    const results = new Array(entries.length);
    const both = [];
    const templates = new Map();
    let next = 0;
    const loop = async () => {
      const worker = inlineWorker();
      workers.push(worker);
      const run = async (index, inProcess, suffix) => {
        const entry = entries[index];
        const script = scripts[entry.hook];
        if (!script) return { error: `unknown hook ${entry.hook}` };
        const invoked = entry.via === 'symlink' ? script.replace(path.join(workRoot, 'stage'), path.join(workRoot, 'stage-link')) : script;
        const verdict = await runOne(invoked, entry, fixtures, workRoot, `${index}${suffix}`, templates, inProcess ? worker : null);
        return verdict ?? { ...(await runOne(invoked, entry, fixtures, workRoot, `${index}${suffix}f`, templates, null)), handedBack: true };
      };
      while (next < entries.length) {
        const index = next++;
        results[index] = await run(index, inline(index), '');
        if (twice(index)) {
          const other = await run(index, !inline(index), 'b');
          both.push(inline(index) ? { index, inline: results[index], process: other } : { index, inline: other, process: results[index] });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, loop));
    return { results, hooks: Object.keys(scripts), parity: both.sort((a, b) => a.index - b.index) };
  } finally {
    for (const worker of workers) worker.close();
    rmSync(workRoot, { recursive: true, force: true });
  }
}

// Cases whose in-process and process verdicts differ. A case the worker handed back ran as a
// process both times, which is reported apart: it proves nothing about the adapter.
export function parityProblems(document, parity) {
  const problems = [];
  for (const { index, inline, process: real } of parity) {
    if (inline.handedBack) continue;
    if (!sameVerdict(inline, real)) problems.push(`#${index} ${document.entries[index].hook} in process ${show(inline)}, as a process ${show(real)}`);
  }
  return problems;
}

const sameVerdict = (a, b) => a.exit === b.exit && a.ruleId === b.ruleId && a.output === b.output;
// A hook whose verdict depends on the Node.js release (for example WHATWG URL parsing of punycode)
// records the other verdict under nodeVariants, keyed by Node major version.
const NODE_MAJOR = process.versions.node.split('.')[0];
const verdictOf = (entry) => {
  const base = entry.change && 'exit' in entry.change ? entry.change : entry;
  const variant = entry.nodeVariants?.[NODE_MAJOR];
  return variant ? { exit: base.exit, ruleId: base.ruleId, output: base.output, ...variant } : base;
};
const describe = (entry, index) => `#${index} ${entry.hook} ${JSON.stringify(entry.raw ?? entry.input).slice(0, 160)}${entry.fixture ? ` [${entry.fixture}]` : ''}`;
const show = (verdict) => `exit=${verdict.exit} ruleId=${verdict.ruleId} output=${verdict.output}`;

// Returns problems: missing hooks, errors, unrecorded entries, and verdict differences.
export function compare(document, { results, hooks }) {
  const problems = [];
  const covered = new Set(document.entries.map((entry) => entry.hook));
  for (const hook of hooks) if (!covered.has(hook)) problems.push(`hook ${hook} has no corpus entry`);
  document.entries.forEach((entry, index) => {
    const actual = results[index];
    if (actual.error) return problems.push(`${describe(entry, index)}: ${actual.error}`);
    if (!('exit' in entry)) return problems.push(`${describe(entry, index)}: not recorded; run npm run hook-verdicts`);
    const expected = verdictOf(entry);
    if (entry.change && !('exit' in entry.change)) return problems.push(`${describe(entry, index)}: change not recorded; run npm run hook-verdicts`);
    if (!sameVerdict(expected, actual)) {
      problems.push(`${describe(entry, index)}: recorded ${show(expected)}, now ${show(actual)}${entry.change ? '' : '; add a change {reason, finding} to accept it'}`);
    }
  });
  return problems;
}

// Fills verdicts for new entries and for entries with a pending change. Refuses silent changes.
export function record(document, { results }) {
  const refused = [];
  document.entries.forEach((entry, index) => {
    const actual = results[index];
    if (actual.error) return refused.push(`${describe(entry, index)}: ${actual.error}`);
    const verdict = { exit: actual.exit, ruleId: actual.ruleId, output: actual.output };
    if (!('exit' in entry)) return Object.assign(entry, verdict);
    if (entry.change) {
      if (!entry.change.reason || !entry.change.finding) return refused.push(`${describe(entry, index)}: change needs reason and finding`);
      if (sameVerdict(entry, actual)) return refused.push(`${describe(entry, index)}: change declared but the verdict equals the baseline`);
      return Object.assign(entry.change, verdict);
    }
    if (!sameVerdict(verdictOf(entry), actual)) refused.push(`${describe(entry, index)}: recorded ${show(entry)}, now ${show(actual)}; add a change {reason, finding} to accept it`);
  });
  return refused;
}

// The stored file groups rows by case (schema 2, see lib/hook-verdict-format.mjs); callers get the flat rows.
export const parseSnapshot = (text) => expandSnapshot(JSON.parse(text));
export function readSnapshot(file = SNAPSHOT) {
  return parseSnapshot(readFileSync(file, 'utf8'));
}

// An expectation is a correctness claim: an unmet one needs a reviewed quarantine entry, keyed by the
// SHA-256 of the case and its expectation so reordering keeps the key and any edit invalidates it. The
// cap is the reviewed size; it went from seven to zero when the seven quarantined defects were fixed.
export const QUARANTINE = path.join(ROOT, 'quality', 'hook-verdict-quarantine.json');
export const QUARANTINE_CAP = 0;
const caseOf = (entry) => [entry.hook, entry.raw ?? null, entry.input ?? null, entry.fixture ?? 'empty', entry.via ?? null, entry.env ?? null];
export function expectationKey(entry) {
  return createHash('sha256').update(JSON.stringify([...caseOf(entry), entry.expectation])).digest('hex');
}
export function expectationMet(entry) {
  if (entry.change && 'exit' in entry.change) return true;
  if (entry.expectation.startsWith('should-allow ')) return entry.exit === 0;
  if (entry.expectation.startsWith('should-block ')) return entry.exit === 2;
  return false;
}
export function quarantineProblems(entries, quarantine, cap = QUARANTINE_CAP) {
  const problems = [];
  if (quarantine.schemaVersion !== 1) problems.push('quarantine schemaVersion must be 1');
  if (Object.keys(quarantine.entries).length > cap) problems.push(`quarantine holds more than ${cap} entries`);
  const used = new Set();
  entries.forEach((entry, index) => {
    if (entry.expectation === undefined || expectationMet(entry)) return;
    const key = expectationKey(entry);
    const item = quarantine.entries[key];
    if (!item) return problems.push(`#${index} ${entry.hook} has an unmet, unquarantined expectation (${key})`);
    if (item.hook !== entry.hook) problems.push(`quarantine ${key}.hook is not ${entry.hook}`);
    for (const field of ['reason', 'followUp']) if (typeof item[field] !== 'string' || !/\S/.test(item[field])) problems.push(`quarantine ${key}.${field} is missing`);
    used.add(key);
  });
  for (const key of Object.keys(quarantine.entries)) if (!used.has(key)) problems.push(`quarantine ${key} is stale`);
  return problems;
}

// Changed-verdict report between a base snapshot and the current one, matched by case. A change from
// allow to block must name its class (`REDO-…` in change.finding); `problems` lists those that do not.
const effective = (entry) => (entry.change && 'exit' in entry.change ? entry.change : entry);
const verdictText = (verdict) => (verdict.exit === 0 ? 'allow' : verdict.exit === 2 ? `block ${verdict.ruleId}` : `exit ${verdict.exit} ${verdict.ruleId}`);
export function summarize(base, current) {
  const pool = new Map();
  for (const entry of base.entries) {
    const key = JSON.stringify(caseOf(entry));
    pool.set(key, [...(pool.get(key) ?? []), entry]);
  }
  const rows = [];
  const problems = [];
  current.entries.forEach((entry, index) => {
    const before = pool.get(JSON.stringify(caseOf(entry)))?.shift();
    if (!before || !('exit' in entry)) return;
    const [from, to] = [effective(before), effective(entry)];
    if (sameVerdict(from, to)) return;
    const direction = from.exit === 0 && to.exit !== 0 ? 'allow to block' : from.exit !== 0 && to.exit === 0 ? 'block to allow' : 'other';
    const kind = /REDO-[A-Z-]+/.exec(entry.change?.finding ?? '')?.[0] ?? null;
    if (direction === 'allow to block' && !kind) problems.push(`#${index} ${entry.hook}: allow to block without a REDO class id`);
    rows.push({ index, hook: entry.hook, direction, from: verdictText(from), to: verdictText(to), output: from.output === to.output ? '' : `${from.output} -> ${to.output}`, kind, text: JSON.stringify(entry.input?.tool_input?.command ?? entry.raw ?? entry.input).slice(0, 100) });
  });
  const added = current.entries.length - base.entries.length;
  const groups = new Map();
  for (const row of rows) {
    const key = [row.direction, row.hook, row.from, row.to, row.kind ?? '(none)'].join(' | ');
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', '\\n');
  const lines = [
    `Changed verdicts: ${rows.length} (${['allow to block', 'block to allow', 'other'].map((d) => `${d}: ${rows.filter((row) => row.direction === d).length}`).join(', ')}); entry count ${added >= 0 ? '+' : ''}${added}.`,
    '',
    '| Direction | Hook | From | To | Class | Entries |',
    '|---|---|---|---|---|---:|',
    ...[...groups].sort().map(([key, count]) => `| ${key.split(' | ').map(cell).join(' | ')} | ${count} |`),
    '',
    '| # | Hook | Command | From | To | Output | Class |',
    '|---:|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.index} | ${row.hook} | \`${cell(row.text)}\` | ${row.from} | ${row.to} | ${cell(row.output)} | ${row.kind ?? ''} |`)
  ];
  return { rows, problems, text: `${lines.join('\n')}\n` };
}

// One entry per line keeps the diff of a verdict change on the lines that changed.
export function serialize(document) {
  if (document.schemaVersion === 2) return serializeCompactSnapshot(document);
  const lines = document.entries.map((entry) => `    ${JSON.stringify(entry)}`);
  const fixtures = Object.entries(document.fixtures).map(([name, steps]) => `    ${JSON.stringify(name)}: ${JSON.stringify(steps)}`);
  const head = Object.entries(document).filter(([key]) => key !== 'fixtures' && key !== 'entries').map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  return `{\n${head.join('\n')}\n  "fixtures": {\n${fixtures.join(',\n')}\n  },\n  "entries": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

async function main() {
  const summary = process.argv.indexOf('--summary');
  if (summary > 0) {
    // --summary [--base REF]: report verdicts changed since REF (default HEAD); nothing is run.
    const baseFlag = process.argv.indexOf('--base');
    const ref = baseFlag > 0 ? process.argv[baseFlag + 1] : 'HEAD';
    const shown = spawnSync('git', ['show', `${ref}:quality/hook-verdicts.json`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (shown.status !== 0) throw new Error(`git show ${ref} failed: ${shown.stderr.trim()}`);
    const report = summarize(parseSnapshot(shown.stdout), readSnapshot());
    process.stdout.write(report.text);
    for (const problem of report.problems) process.stderr.write(`${problem}\n`);
    process.exitCode = report.problems.length ? 1 : 0;
    return;
  }
  const check = process.argv.includes('--check');
  const fileFlag = process.argv.indexOf('--file');
  const file = fileFlag > 0 ? path.resolve(process.argv[fileFlag + 1]) : SNAPSHOT;
  const document = readSnapshot(file);
  const started = Date.now();
  // Recording always runs hook processes; --check runs in process where it can, with the parity
  // sample, and --check --processes runs the whole corpus as processes (release checks).
  const processes = !check || process.argv.includes('--processes');
  const computed = await computeVerdicts(document, processes ? {} : { mode: 'mixed', parity: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (check) {
    const problems = [...compare(document, computed), ...parityProblems(document, computed.parity)].filter((problem) => file === SNAPSHOT || !problem.startsWith('hook '));
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.stdout.write(`${document.entries.length} hook verdicts checked in ${seconds}s, ${problems.length} problems\n`);
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  const refused = record(document, computed);
  const missing = file === SNAPSHOT ? compare(document, computed).filter((problem) => problem.startsWith('hook ')) : [];
  for (const problem of [...refused, ...missing]) process.stderr.write(`${problem}\n`);
  if (refused.length || missing.length) {
    process.exitCode = 1;
    return;
  }
  writeFileSync(file, serialize(document));
  process.stdout.write(`${document.entries.length} hook verdicts recorded in ${seconds}s\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
