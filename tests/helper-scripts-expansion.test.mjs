import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(script, args) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], { encoding: 'utf8' });
}

function scratch() {
  return mkdtempSync(path.join(tmpdir(), 'youdede-helper-scripts-expansion-'));
}

test('work graph validator reports a deterministic frontier and rejects cycles', () => {
  const directory = scratch();
  const validFile = path.join(directory, 'valid.json');
  writeFileSync(validFile, JSON.stringify({ tickets: [
    { id: 'contract', title: 'Define contract', blockedBy: [] },
    { id: 'vertical-slice', title: 'Deliver vertical slice', blockedBy: ['contract'] },
    { id: 'migration', title: 'Complete migration', blockedBy: ['vertical-slice'] }
  ] }));
  const valid = run('artifacts/skills/operations/reviewability/decompose-dependent-work-slices/scripts/validate-work-graph.mjs', [validFile]);
  assert.equal(valid.status, 0, valid.stderr);
  const report = JSON.parse(valid.stdout);
  assert.deepEqual(report.frontier, ['contract']);
  assert.deepEqual(report.topologicalOrder, ['contract', 'vertical-slice', 'migration']);

  const cycleFile = path.join(directory, 'cycle.json');
  writeFileSync(cycleFile, JSON.stringify({ tickets: [
    { id: 'one', title: 'First', blockedBy: ['two'] },
    { id: 'two', title: 'Second', blockedBy: ['one'] }
  ] }));
  const cycle = run('artifacts/skills/operations/reviewability/decompose-dependent-work-slices/scripts/validate-work-graph.mjs', [cycleFile]);
  assert.equal(cycle.status, 1);
  assert.match(cycle.stdout, /dependency cycle includes/);
});

test('exercise plan validator accepts prior prerequisites and rejects forward references', () => {
  const directory = scratch();
  const validFile = path.join(directory, 'course.json');
  writeFileSync(validFile, JSON.stringify({ sections: [{ id: 'foundations', exercises: [
    { id: 'observe-state', objective: 'Observe and explain one visible state transition.', prerequisites: [], variants: ['guided', 'problem'] },
    { id: 'repair-state', objective: 'Repair a broken transition and justify the invariant.', prerequisites: ['observe-state'], variants: ['problem', 'solution'] }
  ] }] }));
  const valid = run('artifacts/skills/writing/education/build-progressive-learning-exercises/scripts/validate-exercise-plan.mjs', [validFile]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).exerciseCount, 2);

  const invalidFile = path.join(directory, 'forward.json');
  writeFileSync(invalidFile, JSON.stringify({ sections: [{ id: 'foundations', exercises: [
    { id: 'repair-state', objective: 'Repair a broken transition and justify the invariant.', prerequisites: ['observe-state'], variants: ['problem'] },
    { id: 'observe-state', objective: 'Observe and explain one visible state transition.', prerequisites: [], variants: ['guided'] }
  ] }] }));
  const invalid = run('artifacts/skills/writing/education/build-progressive-learning-exercises/scripts/validate-exercise-plan.mjs', [invalidFile]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /must appear earlier/);
});

test('setup wizard validator checks syntax, stages, strict mode, and secret exposure', () => {
  const directory = scratch();
  const safeFile = path.join(directory, 'safe.sh');
  writeFileSync(safeFile, `#!/usr/bin/env bash
set -euo pipefail
TOTAL_STAGES=2
stage() { printf '%s\\n' "$1"; }
confirm() { read -r -p "Continue? " answer; [[ "$answer" == yes ]]; }
stage "Inspect prerequisites"
confirm
stage "Apply approved setting"
`);
  const safe = run('artifacts/skills/operations/setup/author-guided-setup-wizard/scripts/validate-setup-wizard.mjs', [safeFile]);
  assert.equal(safe.status, 0, safe.stdout + safe.stderr);
  assert.equal(JSON.parse(safe.stdout).stageCount, 2);

  const unsafeFile = path.join(directory, 'unsafe.sh');
  writeFileSync(unsafeFile, `#!/usr/bin/env bash
set -euxo pipefail
TOTAL_STAGES=1
API_TOKEN=secret
stage() { printf '%s\\n' "$1"; }
stage "Leak"
echo "$API_TOKEN"
`);
  const unsafe = run('artifacts/skills/operations/setup/author-guided-setup-wizard/scripts/validate-setup-wizard.mjs', [unsafeFile]);
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stdout, /shell tracing/);
  assert.match(unsafe.stdout, /secret-like variable/);
});

test('setup wizard validator catches visible secret input, secrets in argv, and comment-only gates', () => {
  const directory = scratch();
  const script = 'artifacts/skills/operations/setup/author-guided-setup-wizard/scripts/validate-setup-wizard.mjs';
  const leaky = path.join(directory, 'leaky.sh');
  writeFileSync(leaky, `#!/usr/bin/env bash
set -euo pipefail
# no confirmation needed here
TOTAL_STAGES=1
stage() { printf '%s\\n' "$1"; }
stage "Token"
read -r -p "Paste your API token: " API_TOKEN
curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com/setup
`);
  const result = run(script, [leaky]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /read without -s/);
  assert.match(result.stdout, /command line/);

  const commentOnlyGate = path.join(directory, 'comment-only-gate.sh');
  writeFileSync(commentOnlyGate, `#!/usr/bin/env bash
set -euo pipefail
# confirmation happens elsewhere
TOTAL_STAGES=1
stage() { printf '%s\\n' "$1"; }
stage "Delete"
rm -rf ./build
`);
  assert.match(run(script, [commentOnlyGate]).stdout, /confirmation/);

  const commented = path.join(directory, 'commented.sh');
  writeFileSync(commented, `#!/usr/bin/env bash
set -euo pipefail # never set -x here
TOTAL_STAGES=1
stage() { printf '%s\\n' "$1"; }
confirm() { read -r -p "Continue? " answer; [[ "$answer" == yes ]]; }
stage "One"
read -rs -p "Token: " API_TOKEN
confirm
`);
  const clean = run(script, [commented]);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
});

test('TypeScript boundary inspector distinguishes entry points from deep imports', () => {
  const directory = scratch();
  const packages = path.join(directory, 'packages');
  mkdirSync(path.join(packages, 'alpha'), { recursive: true });
  mkdirSync(path.join(packages, 'beta', 'lib'), { recursive: true });
  writeFileSync(path.join(packages, 'beta', 'index.ts'), 'export const publicValue = 1;\n');
  writeFileSync(path.join(packages, 'beta', 'lib', 'private.ts'), 'export const privateValue = 2;\n');
  writeFileSync(path.join(packages, 'alpha', 'allowed.ts'), "import { publicValue } from '../beta/index';\nexport { publicValue };\n");
  const clean = run('artifacts/skills/development/architecture/enforce-typescript-module-boundaries/scripts/inspect-module-boundaries.mjs', ['--root', packages]);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);

  writeFileSync(path.join(packages, 'alpha', 'forbidden.ts'), "import { privateValue } from '../beta/lib/private';\nexport { privateValue };\n");
  const blocked = run('artifacts/skills/development/architecture/enforce-typescript-module-boundaries/scripts/inspect-module-boundaries.mjs', ['--root', packages]);
  assert.equal(blocked.status, 1);
  const report = JSON.parse(blocked.stdout);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].reason, 'cross-package-deep-import');
});

test('TypeScript boundary inspector flags a two-segment deep import into a sibling package', () => {
  const directory = scratch();
  const packages = path.join(directory, 'packages');
  mkdirSync(path.join(packages, 'a', 'src'), { recursive: true });
  mkdirSync(path.join(packages, 'b', 'src'), { recursive: true });
  writeFileSync(path.join(packages, 'b', 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(packages, 'a', 'src', 'uses-b.ts'), "import { value } from '../../b/src';\nexport { value };\n");
  const script = 'artifacts/skills/development/architecture/enforce-typescript-module-boundaries/scripts/inspect-module-boundaries.mjs';
  const result = run(script, ['--root', packages]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f) => f.specifier), ['../../b/src']);
});

test('deterministic validators reject missing and malformed inputs at the usage boundary', () => {
  const directory = scratch();
  const malformedJson = path.join(directory, 'malformed.json');
  const malformedShell = path.join(directory, 'malformed.sh');
  writeFileSync(malformedJson, '{not-json');
  writeFileSync(malformedShell, 'echo missing-contract\n');

  const scripts = [
    'artifacts/skills/operations/reviewability/decompose-dependent-work-slices/scripts/validate-work-graph.mjs',
    'artifacts/skills/writing/education/build-progressive-learning-exercises/scripts/validate-exercise-plan.mjs',
    'artifacts/skills/operations/setup/author-guided-setup-wizard/scripts/validate-setup-wizard.mjs',
    'artifacts/skills/development/architecture/enforce-typescript-module-boundaries/scripts/inspect-module-boundaries.mjs'
  ];
  for (const script of scripts) assert.equal(run(script, []).status, 2, script);

  for (const script of scripts.slice(0, 2)) assert.equal(run(script, [malformedJson]).status, 1, script);
  assert.equal(run(scripts[2], [malformedShell]).status, 1);
  assert.equal(run(scripts[3], ['--root', path.join(directory, 'missing')]).status, 2);
});
