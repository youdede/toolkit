#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Records the verdict (exit code, rule id, stdout decision) of every Claude Code hook for every
// corpus entry in quality/hook-verdicts.json, running each hook as a real process from a staged
// install layout, inside a fresh deterministic fixture. The snapshot is the corpus: new entries are
// added without verdict fields and this script fills them. An entry whose verdict differs from the
// recorded one fails unless it carries a `change` object (reason, finding); the new verdict is then
// written into `change`, so the recorded `exit`/`ruleId` stay the baseline. See
// docs/deterministic-components.md.

import { spawn, spawnSync } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function runOne(script, entry, fixtures, workRoot, index, templates) {
  const root = path.join(workRoot, 'runs', String(index));
  let places;
  let template;
  try {
    ({ places, template } = await instantiate(entry.fixture || 'empty', fixtures, workRoot, root, templates));
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
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: places.repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), HOOK_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const verdict = { exit: signal ? `signal:${signal}` : code, ruleId: ruleIdFrom(stderr, stdout, [root, template]), output: summarizeStdout(stdout) };
      rm(root, { recursive: true, force: true }).then(() => resolve(verdict), () => resolve(verdict));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

export async function computeVerdicts(document, { concurrency = Math.max(2, os.availableParallelism?.() ?? os.cpus().length) } = {}) {
  // Canonical path: some hooks only start when argv[1] equals their canonical URL, so a symlinked
  // temp dir (macOS /var) would turn them into no-ops. Entries with via "symlink" exercise that path.
  const workRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'youdede-hook-verdicts-')));
  try {
    const scripts = stageHooks(path.join(workRoot, 'stage'));
    symlinkSync(path.join(workRoot, 'stage'), path.join(workRoot, 'stage-link'));
    const fixtures = { empty: [], ...document.fixtures };
    const results = new Array(document.entries.length);
    const templates = new Map();
    let next = 0;
    const worker = async () => {
      while (next < document.entries.length) {
        const index = next++;
        const entry = document.entries[index];
        const script = scripts[entry.hook];
        const invoked = entry.via === 'symlink' ? script.replace(path.join(workRoot, 'stage'), path.join(workRoot, 'stage-link')) : script;
        results[index] = script ? await runOne(invoked, entry, fixtures, workRoot, index, templates) : { error: `unknown hook ${entry.hook}` };
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { results, hooks: Object.keys(scripts) };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

const sameVerdict = (a, b) => a.exit === b.exit && a.ruleId === b.ruleId && a.output === b.output;
const verdictOf = (entry) => (entry.change && 'exit' in entry.change ? entry.change : entry);
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
    if (!sameVerdict(entry, actual)) refused.push(`${describe(entry, index)}: recorded ${show(entry)}, now ${show(actual)}; add a change {reason, finding} to accept it`);
  });
  return refused;
}

export function readSnapshot(file = SNAPSHOT) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// One entry per line keeps the diff of a verdict change on the lines that changed.
export function serialize(document) {
  const lines = document.entries.map((entry) => `    ${JSON.stringify(entry)}`);
  const fixtures = Object.entries(document.fixtures).map(([name, steps]) => `    ${JSON.stringify(name)}: ${JSON.stringify(steps)}`);
  const head = Object.entries(document).filter(([key]) => key !== 'fixtures' && key !== 'entries').map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  return `{\n${head.join('\n')}\n  "fixtures": {\n${fixtures.join(',\n')}\n  },\n  "entries": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const fileFlag = process.argv.indexOf('--file');
  const file = fileFlag > 0 ? path.resolve(process.argv[fileFlag + 1]) : SNAPSHOT;
  const document = readSnapshot(file);
  const started = Date.now();
  const computed = await computeVerdicts(document);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (check) {
    const problems = compare(document, computed).filter((problem) => file === SNAPSHOT || !problem.startsWith('hook '));
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
