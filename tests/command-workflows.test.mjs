import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateRepository, validateArtifact, ROOT } from '../scripts/lib/catalog.mjs';
import { installArtifact, removeArtifact } from '../scripts/lib/install.mjs';

const SLUGS = ['verify-claims-against-output', 'assemble-review-brief', 'audit-release-evidence'];

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'command-workflows-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('every shipped workflow command validates with zero errors', () => {
  const { results } = validateRepository();
  for (const slug of SLUGS) {
    const result = results.find((r) => r.record.manifest.slug === slug);
    assert.ok(result, `${slug} missing from the catalog`);
    assert.deepEqual(result.errors, [], `${slug} must validate cleanly`);
  }
});

test('duplicate flag names within one command manifest are rejected', () => {
  const { artifacts, taxonomy } = validateRepository();
  const record = artifacts.find(({ manifest }) => manifest.slug === 'assemble-review-brief');
  const broken = structuredClone(record);
  broken.manifest = structuredClone(record.manifest);
  broken.manifest.command.flags = [
    { name: 'scope', effect: 'narrow', description: 'Restrict the brief to a bounded path set.' },
    { name: 'scope', effect: 'narrow', description: 'A second flag colliding with the first one.' }
  ];
  const errors = validateArtifact(broken, taxonomy);
  assert.ok(errors.some((error) => error.includes("duplicates flag 'scope'")));
});

test('clean-worktree commands refuse a dirty tree and pass a clean one', () => withTempRoot((root) => {
  const project = path.join(root, 'project');
  mkdirSync(project, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: project });
  installArtifact('verify-claims-against-output', { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
  const wrapper = path.join(project, '.claude', 'commands', 'youdede', 'verify-claims-against-output', 'check-preconditions.mjs');
  assert.ok(existsSync(wrapper));

  writeFileSync(path.join(project, 'uncommitted.txt'), 'dirty\n');
  const refused = spawnSync(process.execPath, [wrapper], { cwd: project, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /uncommitted change/);

  spawnSync('git', ['add', '.'], { cwd: project });
  spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: project });
  const accepted = spawnSync(process.execPath, [wrapper], { cwd: project, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stdout);

  removeArtifact('verify-claims-against-output', { root: ROOT, target: 'claude-code', scope: 'project', cwd: project });
  assert.ok(!existsSync(wrapper));
}));
