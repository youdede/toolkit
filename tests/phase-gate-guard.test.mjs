import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluate, collectContext } from '../artifacts/hooks/development/workflow/phase-gate-guard/targets/claude-code/phase-gate-guard.mjs';

const SCRIPT = path.resolve('artifacts/hooks/development/workflow/phase-gate-guard/targets/claude-code/phase-gate-guard.mjs');
const runHook = (input, rawOverride) => spawnSync(process.execPath, [SCRIPT], { input: rawOverride ?? JSON.stringify(input), encoding: 'utf8' });
const evidence = (phase) => JSON.stringify({ phase, summary: `Completed ${phase} evidence for the bounded change request.`, anchors: ['src/index.js'] });

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'phase-gate-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const writePhase = (root, phase, content) => ({ tool_name: 'Write', cwd: root, tool_input: { file_path: `.youdede/phases/${phase}.json`, content } });

test('allow: irrelevant writes and a valid first-phase spec pass', () => withTempRoot((root) => {
  assert.equal(evaluate(collectContext({ tool_name: 'Write', cwd: root, tool_input: { file_path: 'src/app.js', content: 'x' } })).exitCode, 0);
  assert.equal(evaluate(collectContext(writePhase(root, 'spec', evidence('spec')))).exitCode, 0);
  assert.equal(evaluate(collectContext(writePhase(root, 'notes', 'free text'), root)).exitCode, 2, 'unknown phases are refused even at chain head');
}));

test('deny-or-observe: advancing a phase without valid predecessor evidence blocks', () => withTempRoot((root) => {
  const missing = evaluate(collectContext(writePhase(root, 'design', evidence('design'))));
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.ruleId, 'predecessor-missing');

  mkdirSync(path.join(root, '.youdede', 'phases'), { recursive: true });
  writeFileSync(path.join(root, '.youdede', 'phases', 'spec.json'), evidence('spec'));
  assert.equal(evaluate(collectContext(writePhase(root, 'design', evidence('design')))).exitCode, 0);

  writeFileSync(path.join(root, '.youdede', 'phases', 'design.json'), evidence('design'));
  const skipped = evaluate(collectContext(writePhase(root, 'implementation', evidence('implementation'))));
  assert.equal(skipped.exitCode, 2);
  assert.equal(skipped.ruleId, 'predecessor-missing');
}));

test('malformed: invalid JSON, phase mismatch, and weak summaries block', () => withTempRoot((root) => {
  assert.equal(evaluate(collectContext(writePhase(root, 'spec', '{not json'))).ruleId, 'malformed-evidence');
  assert.equal(evaluate(collectContext(writePhase(root, 'spec', evidence('design')))).ruleId, 'malformed-evidence');
  assert.equal(evaluate(collectContext(writePhase(root, 'spec', JSON.stringify({ phase: 'spec', summary: 'short', anchors: [] })))).ruleId, 'malformed-evidence');
  mkdirSync(path.join(root, '.youdede', 'phases'), { recursive: true });
  writeFileSync(path.join(root, '.youdede', 'phases', 'spec.json'), '{broken');
  assert.equal(evaluate(collectContext(writePhase(root, 'design', evidence('design')))).ruleId, 'predecessor-invalid');
}));

test('oversized: stdin beyond the cap and oversized evidence files are refused', () => withTempRoot((root) => {
  const huge = runHook(writePhase(root, 'spec', evidence('spec')), `{"pad":"${'x'.repeat(1024 * 1024 + 1)}`);
  assert.equal(huge.status, 2);
  assert.match(huge.stderr, /input-unreadable/);
  mkdirSync(path.join(root, '.youdede', 'phases'), { recursive: true });
  writeFileSync(path.join(root, '.youdede', 'phases', 'spec.json'), `{"pad":"${'x'.repeat(70 * 1024)}`);
  assert.equal(evaluate(collectContext(writePhase(root, 'design', evidence('design')))).ruleId, 'predecessor-unsafe');
  const oversizedTarget = collectContext({
    tool_name: 'Edit',
    cwd: root,
    tool_input: { file_path: '.youdede/phases/spec.json', old_string: 'x', new_string: 'y' }
  });
  assert.equal(evaluate(oversizedTarget).ruleId, 'inspection-failed');
}));

test('boundary: symlinked predecessors and escaping evidence directories block, never follow', () => withTempRoot((root) => {
  if (process.platform === 'win32') return;
  const outside = mkdtempSync(path.join(tmpdir(), 'phase-gate-outside-'));
  try {
    writeFileSync(path.join(outside, 'spec.json'), evidence('spec'));
    mkdirSync(path.join(root, '.youdede', 'phases'), { recursive: true });
    symlinkSync(path.join(outside, 'spec.json'), path.join(root, '.youdede', 'phases', 'spec.json'));
    assert.equal(evaluate(collectContext(writePhase(root, 'design', evidence('design')))).ruleId, 'predecessor-unsafe');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test('false-positive: lookalike paths and normal source writes stay untouched', () => withTempRoot((root) => {
  const inputs = [
    { tool_name: 'Write', cwd: root, tool_input: { file_path: '.youdede/phases-notes/design.json', content: '{}' } },
    { tool_name: 'Write', cwd: root, tool_input: { file_path: 'docs/.youdede/phases/spec.json', content: '{}' } },
    { tool_name: 'Write', cwd: root, tool_input: { file_path: 'docs/.youdede.bak/spec.json', content: '{}' } },
    { tool_name: 'Bash', cwd: root, tool_input: { command: 'echo hi' } }
  ];
  for (const input of inputs) assert.equal(evaluate(collectContext(input)).exitCode, 0, JSON.stringify(input.tool_input));
}));

test('process-exit: the wired hook exits 0 to allow and 2 with a rule id to block', () => withTempRoot((root) => {
  const allowed = runHook(writePhase(root, 'spec', evidence('spec')));
  assert.equal(allowed.status, 0);
  const blocked = runHook(writePhase(root, 'design', evidence('design')));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /BLOCKED by phase-gate-guard \[predecessor-missing\]/);
  assert.doesNotMatch(blocked.stderr, /anchors/, 'diagnostics never echo submitted content');
}));
