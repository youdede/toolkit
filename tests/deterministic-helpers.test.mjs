import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeJson3 } from '../artifacts/skills/research/transcripts/extract-youtube-captions/scripts/normalize-json3.mjs';
import { collectGitState } from '../artifacts/skills/writing/documentation/write-session-handoff/scripts/collect-git-state.mjs';
import { validateSkill } from '../artifacts/skills/development/agent-tooling/author-effective-agent-skill/scripts/validate-skill.mjs';
import { cleanGitEnvironment } from './git-env.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnvironment() });
  assert.equal(result.status, 0, result.stderr);
}

test('caption normalizer decodes entities and removes rolling overlap', () => {
  const result = normalizeJson3({ events: [
    { segs: [{ utf8: 'Hello' }] },
    { segs: [{ utf8: 'Hello world' }] },
    { segs: [{ utf8: 'world &amp; again' }] }
  ] });
  assert.equal(result, 'Hello world & again');
  assert.throws(() => normalizeJson3({}), /events array/);
});

test('handoff collector reports reproducible Git state without writing', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-handoff-state-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, ['init', '-q']);
  git(directory, ['config', 'user.email', 'test@example.test']);
  git(directory, ['config', 'user.name', 'Toolkit Test']);
  writeFileSync(path.join(directory, 'tracked.txt'), 'one\n');
  git(directory, ['add', 'tracked.txt']);
  git(directory, ['commit', '-qm', 'initial']);
  writeFileSync(path.join(directory, 'tracked.txt'), 'two\n');

  const state = collectGitState(directory);
  assert.equal(realpathSync.native(state.root), realpathSync.native(directory));
  assert.match(state.head, /^[a-f0-9]{40}$/);
  assert.match(state.status, /M tracked\.txt/);
  assert.match(state.unstagedStat, /tracked\.txt/);
  assert.match(state.recentCommits, /initial/);
});

test('skill validator checks structure, names, placeholders, and links', (context) => {
  const current = path.resolve('artifacts/skills/development/agent-tooling/author-effective-agent-skill');
  assert.deepEqual(validateSkill(current), { valid: true, errors: [] });

  const root = mkdtempSync(path.join(os.tmpdir(), 'youdede-invalid-skill-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'expected-name');
  mkdirSync(directory);
  writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: wrong-name\ndescription: "A sufficiently long description for a deliberately invalid skill fixture."\n---\n\n# Fixture\n\nTODO\n\n[missing](references/missing.md)\n`);
  const result = validateSkill(directory);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /match folder/.test(error)));
  assert.ok(result.errors.some((error) => /Validation/.test(error)));
  assert.ok(result.errors.some((error) => /Refusals/.test(error)));
  assert.ok(result.errors.some((error) => /TODO/.test(error)));
  assert.ok(result.errors.some((error) => /missing/.test(error)));
});

test('skill validator accepts the optional Agent Skills fields, folded descriptions, and CRLF files', (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'youdede-spec-skill-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'pdf-processing');
  mkdirSync(directory);
  const body = '# PDF processing\n\n## Validation\n\n- Output opens.\n\n## Refusals\n\n- It does not upload files.\n';
  const frontmatter = [
    '---',
    'name: pdf-processing',
    'description: >-',
    '  Extract PDF text, fill forms, and merge files.',
    '  Use when the user works with PDF documents.',
    'license: Apache-2.0',
    'compatibility: Requires poppler-utils',
    'metadata:',
    '  author: example-org',
    'allowed-tools: Read Bash(pdftotext:*)',
    '---',
    ''
  ].join('\n');
  writeFileSync(path.join(directory, 'SKILL.md'), `${frontmatter}${body}`);
  assert.deepEqual(validateSkill(directory), { valid: true, errors: [] });
  writeFileSync(path.join(directory, 'SKILL.md'), `${frontmatter}${body}`.replaceAll('\n', '\r\n'));
  assert.deepEqual(validateSkill(directory), { valid: true, errors: [] });
  writeFileSync(path.join(directory, 'SKILL.md'), `${frontmatter.replace('license: Apache-2.0\n', 'owner: me\n')}${body}`);
  assert.deepEqual(validateSkill(directory).errors, ['unsupported frontmatter fields: owner']);
});
