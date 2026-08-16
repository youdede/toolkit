#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 youdede contributors

import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TOOL_NAMES = {
  'gemini-cli': {
    run_shell_command: 'Bash',
    write_file: 'Write',
    replace: 'Edit',
    read_file: 'Read',
    grep_search: 'Grep',
    glob: 'Glob'
  },
  cursor: {
    Shell: 'Bash',
    Read: 'Read',
    Write: 'Write',
    Grep: 'Grep',
    Delete: 'Write',
    Task: 'Task'
  }
};

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function readEnvelope() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error('bridge-input-limit');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const parsed = raw.trim() ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bridge-envelope-invalid');
  return parsed;
}

function normalizeArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const output = { ...value };
  const aliases = {
    filePath: 'file_path',
    notebookPath: 'notebook_path',
    oldString: 'old_string',
    newString: 'new_string',
    workingDirectory: 'working_directory'
  };
  for (const [source, destination] of Object.entries(aliases)) {
    if (output[destination] === undefined && output[source] !== undefined) output[destination] = output[source];
  }
  return output;
}

function normalizeEnvelope(target, input) {
  return {
    ...input,
    hook_event_name: 'PreToolUse',
    tool_name: TOOL_NAMES[target]?.[input.tool_name] || input.tool_name,
    tool_input: normalizeArguments(input.tool_input),
    cwd: input.cwd || process.cwd()
  };
}

function failClosed(message) {
  process.stderr.write(`BLOCKED by youdede runtime bridge: ${message}.\n`);
  process.exitCode = 2;
}

async function main() {
  const target = option('target');
  const failurePolicy = option('failure-policy') || 'fail-closed';
  if (!Object.hasOwn(TOOL_NAMES, target)) throw new Error('bridge-target-invalid');
  const input = normalizeEnvelope(target, await readEnvelope());
  const ownPath = realpathSync(fileURLToPath(import.meta.url));
  const corePath = ownPath.replace(/\.mjs$/, '.core.mjs');
  const child = spawnSync(process.execPath, [corePath], {
    input: `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
    cwd: input.cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: input.cwd },
    timeout: 32_000,
    maxBuffer: MAX_OUTPUT_BYTES
  });

  if (child.status === 0) {
    const stdout = String(child.stdout || '').trim();
    if (!stdout) {
      process.stdout.write('{}\n');
      return;
    }
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bridge-core-output-invalid');
    process.stdout.write(`${JSON.stringify(parsed)}\n`);
    return;
  }

  if (child.status === 2) {
    process.stderr.write(String(child.stderr || 'Blocked by installed guard.').slice(0, MAX_OUTPUT_BYTES));
    process.exitCode = 2;
    return;
  }

  if (failurePolicy === 'fail-closed') failClosed('the deterministic guard could not complete');
  else process.stdout.write('{}\n');
}

try {
  await main();
} catch {
  failClosed('the adapter could not normalize or execute the hook');
}
