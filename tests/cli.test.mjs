import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadArtifacts, ROOT } from '../scripts/lib/catalog.mjs';

function cli(args) {
  const result = spawnSync(process.execPath, ['./bin/youdede-toolkit.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

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
  assert.match(output, /Authors of this toolkit artifact: youdede contributors/);
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

test('list exposes the complete Codex skill adapter coverage', () => {
  const output = cli(['list', '--kind', 'skill', '--target', 'codex']);
  const expected = loadArtifacts().filter(({ manifest }) => manifest.kind === 'skill').length;
  assert.match(output, /debug-systematically/);
  assert.match(output, /author-effective-agent-skill/);
  assert.match(output, new RegExp(`${expected} artifact\\(s\\)\\.`));
});
