import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'generate-doc-stats.mjs');

test('documented figures are generated, current, and drift is refused', () => {
  const check = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /match the \d+ artifact manifests/);

  // The generator must be idempotent: a fresh run rewrites nothing.
  const generate = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(generate.status, 0, generate.stderr);
  assert.doesNotMatch(generate.stdout, /Updated/);
});
