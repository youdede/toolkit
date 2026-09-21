import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateMarkerInventory, KIND_LABELS } from '../scripts/generate-doc-stats.mjs';

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

test('the generated README matrix is a complete uninterrupted Markdown table', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const matrix = readme.match(
    /<!-- stat-table:readme-matrix -->\n([\s\S]*?)\n<!-- \/stat-table -->/
  )?.[1];
  assert.ok(matrix, 'README matrix markers must delimit the generated table');

  const lines = matrix.split('\n');
  assert.match(lines[0], /^\| \| .+ \|$/);
  assert.match(lines[1], /^\| --- \|(?: ---:\s*\|)+$/);
  assert.equal(lines.length, KIND_LABELS.length + 2, 'one header, one separator, one row per kind');
  assert.ok(lines.every((line) => line.startsWith('| ') && line.endsWith(' |')));
});

test('removing one stat marker is refused even when other markers remain', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const withoutOneSkillMarker = readme.replace(
    /<!-- stat:skill-count -->\d+<!-- \/stat -->/,
    '999'
  );
  assert.notEqual(withoutOneSkillMarker, readme);
  assert.throws(
    () => validateMarkerInventory(withoutOneSkillMarker, 'README.md'),
    /stat:skill-count expected 2, found 1/
  );
});

test('unknown, duplicate, and unbalanced stat markers are refused', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const artifactMarker = readme.match(/<!-- stat:artifact-count -->\d+<!-- \/stat -->/)?.[0];
  assert.ok(artifactMarker);
  assert.throws(
    () => validateMarkerInventory(`${readme}\n<!-- stat-table:unknown -->\nvalue\n<!-- /stat-table -->\n`, 'README.md'),
    /table:unknown expected 0, found 1/
  );
  assert.throws(
    () => validateMarkerInventory(`${readme}\n${artifactMarker}\n`, 'README.md'),
    /stat:artifact-count expected 1, found 2/
  );
  assert.throws(
    () => validateMarkerInventory(readme.replace('<!-- /stat -->', ''), 'README.md'),
    /scalar marker openings \d+, closings \d+/
  );
});
