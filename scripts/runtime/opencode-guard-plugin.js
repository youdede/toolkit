#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const GUARD_TIMEOUT_MS = 10_000;
const TOOL_NAMES = {
  bash: 'Bash',
  shell: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob'
};

function normalizeArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const output = { ...value };
  for (const [source, destination] of Object.entries({
    filePath: 'file_path',
    oldString: 'old_string',
    newString: 'new_string',
    workingDirectory: 'working_directory'
  })) {
    if (output[destination] === undefined && output[source] !== undefined) output[destination] = output[source];
  }
  return output;
}

function policyMessage(child) {
  const message = String(child.stderr || '').trim();
  return message && message.length <= 64 * 1024 ? message : 'Blocked because the installed deterministic guard could not complete safely.';
}

export const YoudedeGuardPlugin = async ({ directory }) => ({
  'tool.execute.before': async (input, output) => {
    if (!['bash', 'shell'].includes(input?.tool)) return;
    const ownPath = fileURLToPath(import.meta.url);
    const corePath = ownPath.replace(/\.js$/, '.core.mjs');
    const requestedCwd = output?.args?.workdir ?? output?.args?.working_directory;
    const cwd = typeof requestedCwd === 'string' && requestedCwd.trim()
      ? path.resolve(directory || process.cwd(), requestedCwd)
      : (directory || process.cwd());
    const envelope = {
      hook_event_name: 'PreToolUse',
      tool_name: TOOL_NAMES[input?.tool] || input?.tool,
      tool_input: normalizeArguments(output?.args),
      cwd
    };
    const serialized = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) {
      throw new Error('Blocked because the shell call exceeds the deterministic guard input limit.');
    }
    const child = spawnSync('node', [corePath], {
      input: serialized,
      encoding: 'utf8',
      cwd: envelope.cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: envelope.cwd },
      timeout: GUARD_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES
    });
    if (child.status !== 0) throw new Error(policyMessage(child));
  }
});
