import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadArtifacts, ROOT } from '../scripts/lib/catalog.mjs';

function cli(args) {
  const result = spawnSync(process.execPath, ['./bin/youdede-toolkit.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function cliRaw(args, cwd = ROOT) {
  return spawnSync(process.execPath, [`${ROOT}/bin/youdede-toolkit.mjs`, ...args], { cwd, encoding: 'utf8' });
}

test('unrecognised flags and commands fail loudly instead of falling back to a default', () => {
  const typo = cliRaw(['add', 'debug-systematically', '--scop', 'user']);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /add does not accept --scop/);
  assert.match(typo.stderr, /--scope/);

  const unknownCommand = cliRaw(['instal', 'debug-systematically']);
  assert.equal(unknownCommand.status, 1);
  assert.match(unknownCommand.stderr, /unknown command 'instal'/);

  const wrongCommandFlag = cliRaw(['doctor', '--json']);
  assert.equal(wrongCommandFlag.status, 1);
  assert.match(wrongCommandFlag.stderr, /doctor does not accept --json/);

  // A one-dash spelling reaches no flag check: it used to sit unread among the positionals while
  // the install chose the default target and exited 0.
  const oneDash = cliRaw(['add', 'debug-systematically', '-target', 'codex', '--dry-run']);
  assert.equal(oneDash.status, 1);
  assert.match(oneDash.stderr, /unknown option '-target'/);
  assert.doesNotMatch(oneDash.stdout, /Would install/);

  const extraWord = cliRaw(['info', 'debug-systematically', 'commit-guard']);
  assert.equal(extraWord.status, 1);
  assert.match(extraWord.stderr, /info takes 1 argument; unexpected: commit-guard/);

  const noArgument = cliRaw(['list', 'skill']);
  assert.equal(noArgument.status, 1);
  assert.match(noArgument.stderr, /list takes no argument; unexpected: skill/);

  // `info` answers from the catalog alone. It accepted these three and read none of them.
  for (const flag of [['--target', 'codex'], ['--scope', 'user'], ['--cwd', '/nonexistent']]) {
    const dead = cliRaw(['info', 'debug-systematically', ...flag]);
    assert.equal(dead.status, 1, `info ${flag[0]}`);
    assert.match(dead.stderr, new RegExp(`info does not accept ${flag[0]}`));
  }
});

test('a filter value the taxonomy does not carry is refused, not answered with an empty catalog', () => {
  const plural = cliRaw(['list', '--kind', 'hooks']);
  assert.equal(plural.status, 1);
  assert.match(plural.stderr, /unknown kind 'hooks'; known kinds: command, context, hook, mcp-server, skill, subagent/);

  const target = cliRaw(['list', '--target', 'claude']);
  assert.equal(target.status, 1);
  assert.match(target.stderr, /unknown target 'claude'; known targets: .*claude-code/);

  // A set too long to print names the file that carries it instead.
  const problem = cliRaw(['list', '--problem', 'commit-safty']);
  assert.equal(problem.status, 1);
  assert.match(problem.stderr, /unknown problem 'commit-safty'; the \d+ known problems are listed in catalog\/taxonomy\.json/);

  const mode = cliRaw(['list', '--execution', 'determinstic']);
  assert.equal(mode.status, 1);
  assert.match(mode.stderr, /unknown execution 'determinstic'; known execution modes: deterministic, hybrid, prompt/);

  // A value the taxonomy carries is a valid question, and no match is a valid answer to it.
  const empty = cliRaw(['list', '--kind', 'hook', '--domain', 'writing']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /0 artifact\(s\)\./);
});

test('a failing command exits non-zero and reports the reason on stderr', () => {
  const missing = cliRaw(['info', 'no-such-artifact-anywhere']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /was not found/);

  const noQuery = cliRaw(['add']);
  assert.equal(noQuery.status, 1);
  assert.match(noQuery.stderr, /requires an artifact id or slug/);
});

test('pack-info is read-only and independent of the working directory state', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youdede-pack-info-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, '.claude'), { recursive: true });
  writeFileSync(path.join(directory, '.claude', 'settings.json'), '{ this is not valid json\n');

  const result = cliRaw(['pack-info', 'accessibility-assurance'], directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Hook fan-out: /);
  assert.match(result.stdout, /focus-style-regression-guard/);

  // An informational command must not create install state or read through the config root.
  assert.deepEqual(readdirSync(path.join(directory, '.claude')), ['settings.json']);
});

test('list composes granular taxonomy filters', () => {
  const output = cli(['list', '--kind', 'skill', '--domain', 'operations', '--category', 'release', '--lifecycle', 'release', '--risk', 'high']);
  const expected = loadArtifacts().filter(({ manifest }) => manifest.kind === 'skill'
    && manifest.domain === 'operations' && manifest.category === 'release'
    && manifest.lifecycle.includes('release') && manifest.risk === 'high').length;
  assert.match(output, /verify-production-release/);
  assert.doesNotMatch(output, /schedule-agent-runs/);
  assert.doesNotMatch(output, /release-risk-reviewer/);
  assert.match(output, new RegExp(`${expected} artifact\\(s\\)\\.`));
});

test('list filters array facets and target support', () => {
  const output = cli(['list', '--framework', 'postgresql', '--language', 'sql', '--target', 'claude-code']);
  const expected = loadArtifacts().filter(({ manifest }) => manifest.frameworks.includes('postgresql')
    && manifest.languages.includes('sql') && Object.hasOwn(manifest.adapters, 'claude-code')).length;
  assert.match(output, /provision-postgres-readonly-role/);
  assert.match(output, /query-production-readonly/);
  assert.match(output, /review-database-migration-plan/);
  assert.match(output, new RegExp(`${expected} artifact\\(s\\)\\.`));
});

test('list filters controlled capabilities independently from granular problem tags', () => {
  const output = cli(['list', '--kind', 'hook', '--capability', 'enforce']);
  const expected = loadArtifacts().filter(({ manifest }) => manifest.kind === 'hook' && manifest.capabilities.includes('enforce')).length;
  assert.match(output, /commit-guard/);
  assert.match(output, new RegExp(`${expected} artifact\\(s\\)\\.`));
});

test('info exposes the full compatibility facets and refusals', () => {
  const output = cli(['info', 'conduct-source-backed-research']);
  assert.match(output, /Languages: agnostic/);
  assert.match(output, /Lifecycle: discovery, review/);
  assert.match(output, /Execution: prompt/);
  assert.match(output, /Capabilities: research/);
  assert.match(output, /Behavior: advisory; failure policy: stop-and-report/);
  assert.match(output, /Target compatibility:/);
  assert.match(output, /Authors of this toolkit artifact: Youdede/);
  assert.match(output, /Integrity: urn:youdede:artifact:sha256:[a-f0-9]{64}/);
  assert.match(output, /gemini-cli \(stable; scopes: project, user\)/);
  assert.match(output, /Refuses:/);
});

test('list exposes hybrid artifacts without changing installation semantics', () => {
  const output = cli(['list', '--execution', 'hybrid']);
  const expected = loadArtifacts().filter(({ manifest }) => manifest.execution.mode === 'hybrid').length;
  assert.match(output, /extract-youtube-captions/);
  assert.match(output, /write-session-handoff/);
  assert.match(output, /author-effective-agent-skill/);
  assert.match(output, new RegExp(`${expected} artifact\\(s\\)\\.`));
});

test('add dry-run emits a machine-readable immutable plan', () => {
  const output = cli(['add', 'debug-systematically', '--dry-run', '--json']);
  const plan = JSON.parse(output);
  assert.equal(plan.artifact.slug, 'debug-systematically');
  assert.equal(plan.target, 'claude-code');
  assert.ok(plan.writes.some((entry) => entry.path.endsWith('SKILL.md')));
  assert.ok(plan.writes.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.match(plan.integrity.integrityId, /^urn:youdede:artifact:sha256:[a-f0-9]{64}$/);
  assert.equal(plan.runtime.automaticExecution, false);
});

test('add dry-run lists every file the real install writes', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youdede-dry-run-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const dry = cli(['add', 'commit-guard', '--cwd', directory, '--dry-run']);
  assert.deepEqual(readdirSync(directory), []);
  const plan = JSON.parse(cli(['add', 'commit-guard', '--cwd', directory, '--dry-run', '--json']));
  assert.deepEqual(plan.notice, { path: path.join('.youdede-toolkit', 'NOTICE.md'), action: 'create' });
  cli(['add', 'commit-guard', '--cwd', directory]);
  const configRoot = path.join(directory, '.claude');
  const written = readdirSync(configRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(configRoot, path.join(entry.parentPath, entry.name)));
  assert.ok(written.includes(path.join('.youdede-toolkit', 'NOTICE.md')));
  for (const file of written) assert.ok(dry.includes(` ${file}`), `dry-run did not list ${file}`);
});

test('verify-integrity exposes the reproducible catalog root and supports one artifact', () => {
  const all = cli(['verify-integrity', '--json']);
  const allResult = JSON.parse(all);
  assert.match(allResult.rootDigest, /^[a-f0-9]{64}$/);
  assert.equal(allResult.artifacts, loadArtifacts().length);
  assert.deepEqual(allResult.findings, []);

  const one = cli(['verify-integrity', 'debug-systematically']);
  assert.match(one, /Verified artifacts: 1/);
  assert.match(one, /No integrity drift found/);
});

test('list exposes only the supported Codex skill adapter coverage', () => {
  const output = cli(['list', '--kind', 'skill', '--target', 'codex']);
  const expected = loadArtifacts().filter(({ manifest, adapters }) => manifest.kind === 'skill' && adapters.codex).length;
  assert.match(output, /debug-systematically/);
  assert.match(output, /author-effective-agent-skill/);
  assert.doesNotMatch(output, /resume-session-work/);
  assert.match(output, new RegExp(`${expected} artifact\\(s\\)\\.`));
});
