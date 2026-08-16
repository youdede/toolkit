#!/usr/bin/env node

import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_PATH_BYTES = 16 * 1024;

const NATIVE_MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function inputToolName(input) {
  const value = input?.tool_name ?? input?.toolName;
  return typeof value === 'string' ? value : '';
}

function inputToolPayload(input) {
  const value = input?.tool_input ?? input?.toolInput;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function mutationTarget(input, toolName) {
  const payload = inputToolPayload(input);
  if (!payload) return { issue: 'workspace-target-missing' };
  const candidates = toolName === 'NotebookEdit'
    ? [payload.notebook_path, payload.notebookPath, payload.file_path, payload.filePath]
    : [payload.file_path, payload.filePath];
  const present = candidates.find((value) => value !== undefined);
  if (present === undefined) return { issue: 'workspace-target-missing' };
  if (typeof present !== 'string' || present.length === 0 || /[\0\r\n]/.test(present)) {
    return { issue: 'workspace-target-invalid' };
  }
  if (Buffer.byteLength(present, 'utf8') > MAX_PATH_BYTES) return { issue: 'workspace-path-too-large' };
  return { value: present };
}

function rootCandidate(input, cwd, environment) {
  const environmentRoot = environment?.CLAUDE_PROJECT_DIR;
  if (typeof environmentRoot === 'string' && environmentRoot.length > 0) return environmentRoot;
  const inputRoot = input?.workspace_root ?? input?.workspaceRoot ?? input?.cwd;
  if (typeof inputRoot === 'string' && inputRoot.length > 0) return inputRoot;
  return cwd;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function nearestExistingAncestor(absoluteTarget) {
  let candidate = absoluteTarget;
  for (;;) {
    let exists = false;
    try {
      lstatSync(candidate);
      exists = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (exists) return realpathSync(candidate);
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('no existing path ancestor');
    candidate = parent;
  }
}

export function collectContext(input, options = {}) {
  const toolName = inputToolName(input);
  if (!NATIVE_MUTATION_TOOLS.has(toolName)) return { relevant: false };

  const target = mutationTarget(input, toolName);
  if (target.issue) return { relevant: true, issue: target.issue };

  const cwd = options.cwd ?? process.cwd();
  const environment = options.env ?? process.env;
  const rawRoot = rootCandidate(input, cwd, environment);
  if (typeof rawRoot !== 'string' || rawRoot.length === 0 || /[\0\r\n]/.test(rawRoot)) {
    return { relevant: true, issue: 'workspace-root-unverified' };
  }
  if (Buffer.byteLength(rawRoot, 'utf8') > MAX_PATH_BYTES) {
    return { relevant: true, issue: 'workspace-root-unverified' };
  }

  try {
    const lexicalRoot = path.resolve(cwd, rawRoot);
    const lexicalTarget = path.resolve(lexicalRoot, target.value);
    const canonicalRoot = realpathSync(lexicalRoot);
    const canonicalAbsoluteTarget = path.isAbsolute(target.value) ? path.resolve(target.value) : null;
    const canonicalAbsoluteAncestor = canonicalAbsoluteTarget ? nearestExistingAncestor(canonicalAbsoluteTarget) : null;
    if (!isContained(lexicalRoot, lexicalTarget)
      && !(canonicalAbsoluteAncestor && isContained(canonicalRoot, canonicalAbsoluteAncestor))) {
      return { relevant: true, lexicalContained: false, canonicalContained: false };
    }
    if (!statSync(canonicalRoot).isDirectory()) {
      return { relevant: true, issue: 'workspace-root-unverified' };
    }
    const canonicalAncestor = canonicalAbsoluteAncestor ?? nearestExistingAncestor(lexicalTarget);
    return {
      relevant: true,
      lexicalContained: true,
      canonicalContained: isContained(canonicalRoot, canonicalAncestor)
    };
  } catch {
    return { relevant: true, issue: 'workspace-boundary-unverified' };
  }
}

const REASONS = {
  'workspace-target-missing': 'the native mutation did not provide a target path',
  'workspace-target-invalid': 'the native mutation target is not a bounded plain path',
  'workspace-path-too-large': 'the native mutation target exceeds the path analysis limit',
  'workspace-root-unverified': 'the project workspace root cannot be established safely',
  'workspace-boundary-unverified': 'the target boundary cannot be inspected safely'
};

function blocked(ruleId, reason) {
  return {
    exitCode: 2,
    ruleId,
    message: `BLOCKED by workspace-boundary-guard [${ruleId}]: ${reason}. Use a target that resolves inside the active project workspace.`
  };
}

export function evaluate(_input, context = {}) {
  if (!context.relevant) return { exitCode: 0, message: '', ruleId: null };
  if (context.issue) return blocked(context.issue, REASONS[context.issue] ?? 'the boundary is not verifiable');
  if (!context.lexicalContained) {
    return blocked('workspace-lexical-escape', 'the normalized target is outside the project workspace');
  }
  if (!context.canonicalContained) {
    return blocked('workspace-symlink-escape', 'an existing path ancestor resolves outside the project workspace');
  }
  return { exitCode: 0, message: '', ruleId: null };
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error(`hook input exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new Error('hook input is not valid JSON');
  }
}

async function main() {
  let result;
  try {
    const input = await readInput();
    result = evaluate(input, collectContext(input));
  } catch (error) {
    result = blocked('workspace-boundary-input-invalid', error.message);
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
