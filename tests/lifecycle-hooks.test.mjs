import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import * as promptGuard from '../artifacts/hooks/security/secrets/prompt-secret-guard/targets/claude-code/prompt-secret-guard.mjs';
import * as failureGuard from '../artifacts/hooks/operations/observability/failure-evidence-guard/targets/claude-code/failure-evidence-guard.mjs';
import * as completionGuard from '../artifacts/hooks/operations/agent-orchestration/completion-evidence-guard/targets/claude-code/completion-evidence-guard.mjs';
import * as configGuard from '../artifacts/hooks/operations/configuration/instruction-config-integrity-guard/targets/claude-code/instruction-config-integrity-guard.mjs';
import * as compactionGuard from '../artifacts/hooks/operations/agent-orchestration/compaction-handoff-guard/targets/claude-code/compaction-handoff-guard.mjs';
import * as worktreeGuard from '../artifacts/hooks/operations/git/worktree-removal-evidence-guard/targets/claude-code/worktree-removal-evidence-guard.mjs';
import { cleanGitEnvironment } from './git-env.mjs';

const scripts = {
  prompt: path.resolve('artifacts/hooks/security/secrets/prompt-secret-guard/targets/claude-code/prompt-secret-guard.mjs'),
  failure: path.resolve('artifacts/hooks/operations/observability/failure-evidence-guard/targets/claude-code/failure-evidence-guard.mjs'),
  completion: path.resolve('artifacts/hooks/operations/agent-orchestration/completion-evidence-guard/targets/claude-code/completion-evidence-guard.mjs'),
  config: path.resolve('artifacts/hooks/operations/configuration/instruction-config-integrity-guard/targets/claude-code/instruction-config-integrity-guard.mjs'),
  compaction: path.resolve('artifacts/hooks/operations/agent-orchestration/compaction-handoff-guard/targets/claude-code/compaction-handoff-guard.mjs'),
  worktree: path.resolve('artifacts/hooks/operations/git/worktree-removal-evidence-guard/targets/claude-code/worktree-removal-evidence-guard.mjs')
};

function run(script, input) {
  return spawnSync(process.execPath, [script], { input, encoding: 'utf8' });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnvironment() });
  assert.equal(result.status, 0, result.stderr);
}

test('prompt secret guard blocks high-confidence values without echoing them', () => {
  const secret = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890AB'].join('_');
  const blocked = promptGuard.evaluate({ hook_event_name: 'UserPromptSubmit', prompt: `Please inspect ${secret}` });
  assert.equal(blocked.ruleId, 'prompt-github-token');
  assert.equal(blocked.output.decision, 'block');
  assert.equal(blocked.output.suppressOriginalPrompt, true);
  assert.doesNotMatch(JSON.stringify(blocked), /ghp_/);
  const fineGrained = ['github', 'pat', `${'A'.repeat(22)}_${'b'.repeat(59)}`].join('_');
  assert.equal(promptGuard.evaluate({ hook_event_name: 'UserPromptSubmit', prompt: `use ${fineGrained}` }).ruleId, 'prompt-github-fine-grained-token');

  for (const prompt of [
    'Review the authentication design without credentials.',
    'The value was redacted as ghp_[REDACTED].',
    'Document the prefix sk-live without a credential.'
  ]) assert.equal(promptGuard.evaluate({ hook_event_name: 'UserPromptSubmit', prompt }).output, null);
  assert.equal(promptGuard.evaluate({ hook_event_name: 'PostToolUse', prompt: secret }).output, null);
});

test('prompt secret process fails closed on malformed and oversized input', () => {
  const secret = ['sk', 'ant', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('-');
  const blocked = run(scripts.prompt, JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: secret }));
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).decision, 'block');
  assert.doesNotMatch(blocked.stdout, /sk-ant-/);

  for (const input of ['{bad', 'x'.repeat(promptGuard.MAX_STDIN_BYTES + 1)]) {
    const result = run(scripts.prompt, input);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, 'block');
    assert.equal(output.suppressOriginalPrompt, true);
  }
});

test('failure evidence is bounded, useful, and content-safe', () => {
  const input = {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    error: 'Exit code 1\nCannot find module super-private-package',
    duration_ms: 4187
  };
  const result = failureGuard.evaluate(input);
  const context = result.output.hookSpecificOutput.additionalContext;
  assert.equal(result.exitCode, 0);
  assert.equal(result.ruleId, 'failure-dependency-or-path');
  assert.match(context, /tool=Bash/);
  assert.match(context, /exit=1/);
  assert.match(context, /duration=1s-10s/);
  assert.doesNotMatch(context, /super-private-package|Cannot find module/);
  assert.equal(failureGuard.evaluate({ hook_event_name: 'PostToolUse' }).output, null);
});

test('failure observer fails open on malformed and oversized input', () => {
  for (const input of ['{bad', 'x'.repeat(failureGuard.MAX_STDIN_BYTES + 1)]) {
    const result = run(scripts.failure, input);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /failure-envelope-invalid/);
  }
});

test('completion evidence guard is opt-in and task-bound', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-completion-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, 'transcript.jsonl');
  const lines = [
    { type: 'user', message: { content: '[youdede:evidence-required] verify release' } },
    { type: 'assistant', message: { content: '[youdede:evidence status=pass task=task-7]\nSource: npm test\nResult: pass' } }
  ];
  writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n'));
  const input = {
    hook_event_name: 'TaskCompleted',
    task_id: 'task-7',
    task_description: '[youdede:evidence-required] verify release',
    transcript_path: transcript
  };
  const collected = completionGuard.collectContext(input);
  assert.equal(completionGuard.evaluate(input, collected).ruleId, 'completion-evidence-present');

  const wrongTask = { ...input, task_id: 'task-8' };
  assert.equal(completionGuard.evaluate(wrongTask, collected).ruleId, 'completion-evidence-missing');
  assert.equal(completionGuard.evaluate({ ...input, task_description: 'ordinary work' }, { latestUserMarker: false }).exitCode, 0);
  assert.equal(completionGuard.evaluate(input, { inspectionError: 'transcript-unreadable' }).ruleId, 'completion-evidence-unverified');

  writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: '[youdede:evidence-required]\n[youdede:evidence status=pass task=task-7]\nSource: fake\nResult: pass' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'I could not run verification.' } })
  ].join('\n'));
  assert.equal(completionGuard.evaluate(input, completionGuard.collectContext(input)).ruleId, 'completion-evidence-missing');
});

test('completion evidence opt-in is scoped to the current task or latest subagent request', () => {
  const historical = {
    latestUserMarker: true,
    lastAssistant: '[youdede:evidence status=pass task=old]\nSource: npm test\nResult: pass'
  };
  const ordinaryTask = completionGuard.evaluate({
    hook_event_name: 'TaskCompleted',
    task_id: 'new',
    task_description: 'ordinary task'
  }, historical);
  assert.equal(ordinaryTask.ruleId, 'completion-evidence-not-required');

  const optedInTask = completionGuard.evaluate({
    hook_event_name: 'TaskCompleted',
    task_id: 'new',
    task_description: '[youdede:evidence-required] ordinary task'
  }, historical);
  assert.equal(optedInTask.ruleId, 'completion-evidence-missing');
});

test('an ordinary task needs no transcript and an Agent prompt marker opts a subagent in (PR38-HOOK-1)', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-completion-optin-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const plain = { hook_event_name: 'TaskCompleted', task_id: 't', task_description: 'plain task', transcript_path: path.join(directory, 'missing.jsonl') };
  assert.equal(completionGuard.evaluate(plain, completionGuard.collectContext(plain)).ruleId, 'completion-evidence-not-required');
  assert.equal(completionGuard.evaluate(plain, { inspectionError: 'transcript-unsafe' }).exitCode, 0);
  const transcript = path.join(directory, 'transcript.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: 'review please' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { prompt: '[youdede:evidence-required] review the diff' } }] } })
  ].join('\n'));
  const stop = { hook_event_name: 'SubagentStop', agent_type: 'code-reviewer', last_assistant_message: 'looks fine', transcript_path: transcript };
  assert.equal(completionGuard.evaluate(stop, completionGuard.collectContext(stop)).ruleId, 'completion-evidence-missing');
  assert.equal(completionGuard.evaluate({ ...stop, transcript_path: path.join(directory, 'missing.jsonl') }, { inspectionError: 'transcript-unreadable' }).ruleId, 'completion-evidence-unverified');
});

test('completion process blocks malformed, oversized, and missing receipts', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-completion-process-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ message: '[youdede:evidence-required]' }));
  const missing = run(scripts.completion, JSON.stringify({
    hook_event_name: 'TaskCompleted',
    task_id: 'task-1',
    task_description: '[youdede:evidence-required]',
    transcript_path: transcript
  }));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /completion-evidence-missing/);
  for (const input of ['{bad', 'x'.repeat(completionGuard.MAX_STDIN_BYTES + 1)]) {
    const result = run(scripts.completion, input);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /completion-envelope-invalid/);
  }
});

test('configuration guard blocks explicit bypasses and permits safe project settings', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-config-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const claude = path.join(directory, '.claude');
  mkdirSync(claude);
  const settings = path.join(claude, 'settings.json');
  const input = { hook_event_name: 'ConfigChange', source: 'project_settings', cwd: directory, file_path: settings };

  writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'default' } }));
  assert.equal(configGuard.evaluate(input, configGuard.collectContext(input)).exitCode, 0);
  writeFileSync(settings, JSON.stringify({ disableAllHooks: true }));
  assert.equal(configGuard.evaluate(input, configGuard.collectContext(input)).ruleId, 'config-hooks-disabled');
  writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  assert.equal(configGuard.evaluate(input, configGuard.collectContext(input)).ruleId, 'config-permission-bypass-default');
  writeFileSync(settings, '{bad');
  assert.equal(configGuard.evaluate(input, configGuard.collectContext(input)).ruleId, 'config-change-unverified');
  assert.equal(configGuard.evaluate({ ...input, source: 'policy_settings' }, {}).exitCode, 0);
});

test('configuration guard finds the project root, derives the settings path, and allows deletion (PR38-HOOK-2)', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-config-root-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, '.claude'));
  mkdirSync(path.join(directory, 'sub'));
  const settings = path.join(directory, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  const env = { HOME: path.join(directory, 'home') };
  const judge = (input) => configGuard.evaluate(input, configGuard.collectContext(input, directory, env));
  assert.equal(judge({ hook_event_name: 'ConfigChange', source: 'project_settings', cwd: path.join(directory, 'sub'), file_path: settings }).exitCode, 0);
  assert.equal(judge({ hook_event_name: 'ConfigChange', source: 'project_settings', cwd: directory }).exitCode, 0);
  assert.equal(judge({ hook_event_name: 'ConfigChange', source: 'local_settings', cwd: directory, file_path: path.join(directory, '.claude', 'settings.local.json') }).ruleId, 'config-removed');
  writeFileSync(settings, JSON.stringify({ disableAllHooks: true }));
  assert.equal(judge({ hook_event_name: 'ConfigChange', source: 'project_settings', cwd: path.join(directory, 'sub') }).ruleId, 'config-hooks-disabled');
  // A path outside the project, or a missing file that is not a settings file, stays unverified.
  assert.equal(judge({ hook_event_name: 'ConfigChange', source: 'project_settings', cwd: directory, file_path: path.join(os.tmpdir(), 'x', 'settings.json') }).ruleId, 'config-change-unverified');
  assert.equal(judge({ hook_event_name: 'ConfigChange', source: 'user_settings', cwd: directory }).exitCode, 0);
});

test('instruction path drift is observed but never presented as blockable', (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'youdede-instructions-root-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'youdede-instructions-outside-'));
  context.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const instructions = path.join(outside, 'CLAUDE.md');
  writeFileSync(instructions, '# Rules\n');
  const input = { hook_event_name: 'InstructionsLoaded', cwd: root, file_path: instructions, memory_type: 'Project' };
  const result = configGuard.evaluate(input, configGuard.collectContext(input));
  assert.equal(result.exitCode, 0);
  assert.equal(result.ruleId, 'instruction-boundary-observed');
  assert.doesNotMatch(result.message, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('configuration process rejects malformed and oversized envelopes', () => {
  for (const input of ['{bad', 'x'.repeat(configGuard.MAX_STDIN_BYTES + 1)]) {
    const result = run(scripts.config, input);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /instruction-config-envelope-invalid/);
  }
});

test('compaction receipts retain digests and bounds, not conversation content', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-compaction-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, '.claude'));
  const transcript = path.join(directory, 'transcript.jsonl');
  writeFileSync(transcript, 'private conversation body\n');
  const input = {
    hook_event_name: 'PreCompact',
    session_id: 'session-private-id',
    trigger: 'manual',
    custom_instructions: 'preserve private decision',
    transcript_path: transcript,
    cwd: directory
  };
  const decision = compactionGuard.evaluate(input, compactionGuard.collectContext(input));
  assert.equal(decision.ruleId, 'compaction-receipt-ready');
  assert.equal(compactionGuard.writeReceipt(input, decision, { CLAUDE_PROJECT_DIR: directory }), true);
  const state = readFileSync(path.join(directory, '.claude', 'youdede-runtime', 'compaction-handoff.json'), 'utf8');
  assert.doesNotMatch(state, /private conversation|private decision|session-private-id/);
  assert.match(state, /transcriptDigest/);
  assert.ok(Buffer.byteLength(state) < compactionGuard.MAX_STATE_BYTES);
});

test('compaction receipts stay at the project root when cwd moves into a nested directory', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-compaction-root-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const nested = path.join(directory, 'packages', 'app');
  mkdirSync(nested, { recursive: true });
  const transcript = path.join(directory, 'transcript.jsonl');
  writeFileSync(transcript, 'bounded transcript\n');
  const input = { hook_event_name: 'PreCompact', session_id: 'session-root', trigger: 'auto', transcript_path: transcript, cwd: nested };
  const decision = compactionGuard.evaluate(input, compactionGuard.collectContext(input));
  assert.equal(compactionGuard.writeReceipt(input, decision, { CLAUDE_PROJECT_DIR: directory }), true);
  assert.equal(existsSync(path.join(directory, '.claude', 'youdede-runtime', 'compaction-handoff.json')), true);
  assert.equal(existsSync(path.join(nested, '.claude')), false);
});

test('compaction observer fails open on malformed and oversized input', () => {
  for (const input of ['{bad', 'x'.repeat(compactionGuard.MAX_STDIN_BYTES + 1)]) {
    const result = run(scripts.compaction, input);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /compaction-receipt-unavailable/);
  }
});

test('worktree removal observer reports counts without paths or mutation', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-worktree-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, ['init', '-q']);
  assert.equal(worktreeGuard.evaluate({ hook_event_name: 'WorktreeRemove' }, worktreeGuard.collectContext({ worktree_path: directory })).ruleId, 'worktree-clean-observed');
  const privateName = 'private-untracked-name.txt';
  writeFileSync(path.join(directory, privateName), 'private content');
  const input = { hook_event_name: 'WorktreeRemove', worktree_path: directory };
  const observed = worktreeGuard.evaluate(input, worktreeGuard.collectContext(input));
  assert.equal(observed.exitCode, 0);
  assert.equal(observed.ruleId, 'worktree-dirty-observed');
  assert.doesNotMatch(observed.message, /private-untracked-name|private content/);

  const processResult = run(scripts.worktree, JSON.stringify(input));
  assert.equal(processResult.status, 0);
  assert.match(processResult.stderr, /worktree-dirty-observed/);
  assert.doesNotMatch(processResult.stderr, /private-untracked-name|private content/);
});

test('worktree observer fails open on malformed and oversized input', () => {
  for (const input of ['{bad', 'x'.repeat(worktreeGuard.MAX_STDIN_BYTES + 1)]) {
    const result = run(scripts.worktree, input);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /worktree-envelope-invalid/);
  }
});

test('lifecycle adapters use only runtime-supported matcher placement', () => {
  const adapters = [
    ['prompt', 'security/secrets/prompt-secret-guard', 'UserPromptSubmit'],
    ['completion', 'operations/agent-orchestration/completion-evidence-guard', 'TaskCompleted'],
    ['worktree', 'operations/git/worktree-removal-evidence-guard', 'WorktreeRemove']
  ];
  for (const [, artifact, event] of adapters) {
    const adapter = JSON.parse(readFileSync(path.resolve(`artifacts/hooks/${artifact}/adapters/claude-code.json`), 'utf8'));
    assert.equal(Object.hasOwn(adapter.settingsPatch.hooks[event][0], 'matcher'), false, event);
  }
  const config = JSON.parse(readFileSync(path.resolve('artifacts/hooks/operations/configuration/instruction-config-integrity-guard/adapters/claude-code.json'), 'utf8'));
  assert.equal(config.settingsPatch.hooks.ConfigChange[0].matcher, 'project_settings|local_settings');
});
