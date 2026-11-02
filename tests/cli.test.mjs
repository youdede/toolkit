import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // `doctor` reads --json now, so the flag it must still refuse is one it has no use for.
  const wrongCommandFlag = cliRaw(['doctor', '--kind', 'hook']);
  assert.equal(wrongCommandFlag.status, 1);
  assert.match(wrongCommandFlag.stderr, /doctor does not accept --kind/);

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


test('version is reported, and the flag spelling works as well as the command', () => {
  const expected = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const argv of [['version'], ['--version']]) {
    const result = cliRaw(argv);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${expected.name} ${expected.version}`, argv.join(' '));
  }
  assert.deepEqual(JSON.parse(cli(['version', '--json'])), { name: expected.name, version: expected.version });
});

test('list and info answer in JSON with a stable summary of the catalog', () => {
  const listed = JSON.parse(cli(['list', '--kind', 'command', '--json']));
  assert.equal(listed.count, listed.artifacts.length);
  assert.ok(listed.count > 0);
  assert.deepEqual([...new Set(listed.artifacts.map(({ kind }) => kind))], ['command']);
  for (const record of listed.artifacts) {
    assert.deepEqual(Object.keys(record).sort(), [
      'category', 'domain', 'execution', 'id', 'kind', 'lifecycle', 'name', 'risk', 'slug', 'summary', 'targets', 'version'
    ]);
  }
  // The human and JSON paths answer the same question, so they must agree on the count.
  assert.match(cli(['list', '--kind', 'command']), new RegExp(`${listed.count} artifact\\(s\\)\\.`));

  const described = JSON.parse(cli(['info', 'commit-guard', '--json']));
  assert.equal(described.id, 'hook/security/secrets/commit-guard');
  assert.match(described.integrity, /^urn:youdede:artifact:sha256:[0-9a-f]{64}$/);
  assert.ok(described.refuses.length > 0);
  const claude = described.targetCompatibility.find(({ target }) => target === 'claude-code');
  assert.deepEqual(claude.scopes, ['project']);
});

test('search ranks by the fields a term hit and requires every term to match', () => {
  const found = JSON.parse(cli(['search', 'secret', '--json']));
  assert.deepEqual(found.terms, ['secret']);
  assert.equal(found.count, found.results.length);
  assert.ok(found.count > 0);
  // Ranked by how many fields matched, so a result is never ahead of one that matched more.
  const scores = found.results.map(({ matchedFields }) => matchedFields.length);
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left));
  for (const result of found.results) {
    assert.ok(result.matchedFields.length > 0);
    for (const field of result.matchedFields) assert.ok(['name', 'slug', 'summary', 'refuses'].includes(field));
  }
  // An artifact found only through what it refuses to do is the point of searching refusals.
  assert.ok(found.results.some(({ matchedFields }) => matchedFields.includes('refuses')));

  // Every term must match, so adding one can only narrow the result.
  const narrowed = JSON.parse(cli(['search', 'secret', 'commit', '--json']));
  assert.ok(narrowed.count > 0);
  assert.ok(narrowed.count < found.count);
  const narrowedIds = new Set(narrowed.results.map(({ id }) => id));
  assert.ok([...narrowedIds].every((id) => found.results.some((result) => result.id === id)));

  // Filters still apply to a search.
  const filtered = JSON.parse(cli(['search', 'secret', '--kind', 'hook', '--json']));
  assert.deepEqual([...new Set(filtered.results.map(({ kind }) => kind))], ['hook']);

  // A term nothing carries is an answer, not a refusal; no term at all is a refusal.
  const empty = cliRaw(['search', 'zzzzznotathing']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /0 artifact\(s\) matching/);
  const noTerm = cliRaw(['search']);
  assert.equal(noTerm.status, 1);
  assert.match(noTerm.stderr, /search requires at least one term/);
});

test('installed reports what the state records, and doctor answers in JSON', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youdede-installed-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const added = cliRaw(['add', 'commit-guard', '--cwd', directory]);
  assert.equal(added.status, 0, added.stderr);

  const inventory = JSON.parse(cli(['installed', '--cwd', directory, '--json']));
  assert.equal(inventory.target, 'claude-code');
  assert.equal(inventory.scope, 'project');
  const ids = inventory.installs.map(({ artifactId }) => artifactId);
  assert.ok(ids.includes('hook/security/secrets/commit-guard'));
  // The prerequisite it pulled in is installed too, so an inventory must show it.
  assert.ok(ids.includes('hook/security/application-security/shell-command-guard'));
  for (const install of inventory.installs) assert.deepEqual(install.owners, ['direct']);

  const health = JSON.parse(cli(['doctor', '--cwd', directory, '--json']));
  assert.equal(health.installs, inventory.installs.length);
  assert.deepEqual(health.findings, []);
});

test('a removal dry run writes nothing and names exactly what the removal then does', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youdede-remove-plan-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(cliRaw(['add', 'commit-guard', '--cwd', directory]).status, 0);

  const tree = () => readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath ?? entry.path, entry.name)))
    .sort();
  const before = tree();
  const plan = JSON.parse(cli(['remove', 'commit-guard', '--cwd', directory, '--dry-run', '--json']));
  assert.deepEqual(tree(), before, 'a dry run must leave the tree byte-for-byte');

  assert.equal(plan.artifact, 'hook/security/secrets/commit-guard');
  assert.deepEqual(plan.dependents, []);
  const planned = plan.removes.filter(({ action }) => action === 'delete').map(({ path: file }) => file);
  assert.ok(planned.length > 0);

  // The settings file keeps the prerequisite's hook, so the plan must say update, not delete.
  assert.equal(plan.settings.action, 'update');
  assert.equal(plan.state.action, 'update');

  const removed = cliRaw(['remove', 'commit-guard', '--cwd', directory]);
  assert.equal(removed.status, 0, removed.stderr);
  for (const file of planned) {
    assert.equal(existsSync(path.join(directory, '.claude', file)), false, `${file} was planned for deletion`);
  }
  // And what the plan did not list is still there.
  assert.ok(existsSync(path.join(directory, '.claude', plan.settings.path)));
  assert.ok(existsSync(path.join(directory, '.claude', plan.state.path)));
});

test('a pack removal dry run keeps the tree and reports every member', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youdede-remove-pack-plan-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(cliRaw(['add-pack', 'plan-and-verify-loop', '--cwd', directory]).status, 0);
  const count = () => readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
  const before = count();

  const plan = JSON.parse(cli(['remove-pack', 'plan-and-verify-loop', '--cwd', directory, '--dry-run', '--json']));
  assert.equal(count(), before, 'a dry run must write nothing');
  assert.equal(plan.pack, 'pack/plan-and-verify-loop');
  assert.ok(plan.members.length > 1);
  assert.deepEqual(plan.dependents, []);
  // Nothing outside the pack owns the roots, so both would go once the last member leaves.
  for (const root of plan.roots) {
    assert.equal(root.state.action, 'delete');
    assert.equal(root.notice.action, 'delete');
  }
  // A file two members both record is deleted with the last of them, never reported as kept.
  const shared = plan.members.flatMap(({ removes }) => removes).filter(({ path: file }) => file.includes('/lib/'));
  assert.ok(shared.length > 1);
  for (const entry of shared) assert.equal(entry.action, 'delete');
});

test('shell completion is generated for the shells it names and refuses the rest', () => {
  for (const shell of ['bash', 'zsh']) {
    const script = cli(['completion', shell]);
    assert.match(script, /_youdede_toolkit\(\)/);
    assert.match(script, /complete -F _youdede_toolkit youdede-toolkit/);
    // Generated from the same tables the parser uses, so the commands and a per-command flag list
    // cannot drift from what the CLI accepts.
    assert.match(script, /search/);
    assert.match(script, /--no-prerequisites/);
    assert.match(script, /claude-code codex cursor gemini-cli github-copilot opencode/);
    // A value-taking flag must be known as such, or its value is read as the command.
    assert.match(script, /--target\|--scope/);
    if (shell === 'zsh') assert.match(script, /bashcompinit/);
  }
  const unknown = cliRaw(['completion', 'fish']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown shell 'fish'; known shells: bash, zsh/);
});
