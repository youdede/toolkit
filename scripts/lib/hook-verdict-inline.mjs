// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// In-process hook verdicts. Starting Node.js for each of the 15,000 verdict cases costs most of the
// verdict run, so a case can instead run inside a long-lived worker process (this file, forked by
// scripts/record-hook-verdicts.mjs): the worker takes the case's environment and working directory,
// imports the staged hook once, calls its exported `evaluate`, and writes what the hook's own main
// would write. ADAPTERS reproduces each main; tests/hook-verdicts.test.mjs runs a sample of cases both
// ways and fails when the two verdicts differ. A hook whose main does more than evaluate (a ledger
// subprocess, a receipt) has no adapter and always runs as a process.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// What the main writes for a result, by shape: its message when it has one; its message on a block;
// `[ruleId] message` on a block.
const MESSAGE = (result) => ({ stderr: result.message ? `${result.message}\n` : '', exit: result.exitCode });
const ON_BLOCK = (result) => ({ stderr: result.exitCode ? `${result.message}\n` : '', exit: result.exitCode });
const BRACKET = (result) => ({ stderr: result.exitCode ? `[${result.ruleId}] ${result.message}\n` : '', exit: result.exitCode });

const withContext = (write) => (hook, input) => write(hook.evaluate(input, hook.collectContext(input)));
const alone = (write) => (hook, input) => write(hook.evaluate(input));
const projectRoot = (input) => process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const pins = (script) => JSON.parse(readFileSync(path.join(path.dirname(script), 'mcp-pins.json'), 'utf8'));
const json = (value) => (value ? `${JSON.stringify(value)}\n` : '');
const group = (hooks, adapter) => hooks.map((hook) => [`${hook}-guard`, adapter]);

export const ADAPTERS = Object.fromEntries([
  ...group(['schema-compatibility', 'migration-safety', 'authentication-accessibility', 'focus-style-regression',
    'accessibility-attribute-regression', 'test-assertion-removal', 'binary-mutation', 'generated-file', 'api-contract-compatibility',
    'debug-artifact', 'lint-suppression', 'exception-swallowing', 'test-integrity', 'completion-evidence', 'instruction-config-integrity',
    'subagent-fanout', 'protected-branch', 'workspace-boundary', 'dependency-change', 'unsafe-deserialization', 'ci-trust-boundary'], withContext(MESSAGE)),
  ...group(['database-query-mode', 'policy-file', 'foreground-process', 'outbound-data', 'shell-command', 'commit'], alone(MESSAGE)),
  ...group(['cloud-resource-deletion', 'container-registry-publish', 'infrastructure-apply', 'package-publish', 'scheduled-task-mutation',
    'system-service-mutation', 'archive-extraction', 'system-path-mutation', 'user-account-mutation', 'firewall-policy-mutation'], alone(ON_BLOCK)),
  ...group(['release-clean-state', 'commit-signature-intent', 'ci-reference-pinning', 'executable-permission', 'submodule-target',
    'install-lifecycle-script', 'lockfile-origin', 'large-diff-review', 'path-portability', 'release-version-consistency', 'dependency-source',
    'symlink-publication'], withContext(BRACKET)),
  ['sensitive-file-access-guard', (hook, input) => MESSAGE(hook.evaluate(input, hook.collectRuntimeContext(input)))],
  ...group(['dynamic-code-execution', 'transport-security-regression'], (hook, input) => ON_BLOCK(hook.evaluate(input, hook.reconstructChange(input, projectRoot(input))))),
  ['container-privilege-guard', (hook, input) => {
    const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    return ON_BLOCK(hook.evaluate(input, input.tool_name === 'Bash' ? undefined : hook.reconstructChange(input, cwd)));
  }],
  ['mcp-capability-drift-guard', (hook, input, script) => MESSAGE(hook.evaluate(input, pins(script)))],
  ['mcp-egress-guard', (hook, input, script) => MESSAGE(hook.evaluate(input, pins(script), projectRoot(input)))],
  ['phase-gate-guard', (hook, input) => {
    const decision = hook.evaluate(hook.collectContext(input));
    return { stderr: decision.exitCode !== 0 ? `${decision.message}\n` : '', exit: decision.exitCode };
  }],
  ['tool-output-budget-guard', (hook, input) => {
    const guidance = hook.evaluate(hook.collectContext(input)).guidance;
    return { stdout: json(guidance && { systemMessage: guidance }), exit: 0 };
  }],
  ['failure-evidence-guard', (hook, input) => ({ stdout: json(hook.evaluate(input).output), exit: 0 })],
  ['prompt-secret-guard', (hook, input) => {
    const decision = hook.evaluate(input);
    return { stdout: json(decision.output), exit: decision.exitCode };
  }],
  ['worktree-removal-evidence-guard', (hook, input) => ({ ...MESSAGE(hook.evaluate(input, hook.collectContext(input))), exit: 0 })]
]);

// Their mains append to the session ledger or write a receipt through a subprocess.
export const PROCESS_ONLY = ['compaction-handoff-guard', 'compact-readiness-guard', 'session-checkpoint-guard', 'session-restore-guard'];

// Cases about the process itself: stdin that is not a JSON object, the argv/symlink entry, size
// limits, and the rows taken from process-level tests.
export function testsProcess(entry) {
  const input = entry.input;
  return entry.raw !== undefined || entry.via !== undefined || /process/.test(entry.source ?? '')
    || !input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).includes('{{repeat:');
}

const modules = new Map();
// Runs one case in this process. A throw, or a result that is not a plain value, makes the caller run
// the case as a process instead, since only the hook's own main knows how it reports that.
async function runCase({ hook, script, stdin, env, cwd }) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(cwd);
  if (!modules.has(script)) modules.set(script, await import(pathToFileURL(script).href));
  const written = { stdout: '', stderr: '' };
  const writes = { stdout: process.stdout.write, stderr: process.stderr.write };
  for (const stream of ['stdout', 'stderr']) process[stream].write = (chunk) => { written[stream] += String(chunk); return true; };
  try {
    const loaded = modules.get(script);
    const evaluate = (...args) => {
      const value = loaded.evaluate(...args);
      if (typeof value?.then === 'function') throw new Error('asynchronous evaluate');
      return value;
    };
    const result = ADAPTERS[hook]({ ...loaded, evaluate }, JSON.parse(stdin), script);
    return { stdout: written.stdout + (result.stdout ?? ''), stderr: written.stderr + (result.stderr ?? ''), exit: result.exit ?? 0 };
  } finally {
    Object.assign(process.stdout, { write: writes.stdout });
    Object.assign(process.stderr, { write: writes.stderr });
  }
}

if (process.send && process.argv.includes('--hook-verdict-worker')) {
  process.on('message', async (job) => {
    try {
      process.send({ id: job.id, ...(await runCase(job)) });
    } catch (error) {
      process.send({ id: job.id, fallback: String(error?.message ?? error) });
    }
  });
}
