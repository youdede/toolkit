#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Shared deterministic precondition evaluator for command artifacts. A command declares its
// preconditions as data in a bounded JSON document; this bridge evaluates them and exits 0 when
// every check passes, 1 with a machine-readable failure list otherwise. No model judgment, no
// network, no writes: the bridge only inspects local state.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_CHECKS = 32;
const MAX_PATHS_PER_CHECK = 64;
const GIT_TIMEOUT_MS = 5000;
const KNOWN_CHECKS = new Set(['git-clean', 'file-exists', 'evidence-valid']);

function fail(code, message) {
  process.stdout.write(`${JSON.stringify({ ok: false, code, failures: [message] })}\n`);
  process.exit(1);
}

function safeRelative(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  if (path.isAbsolute(candidate) || candidate.split('/').includes('..')) return null;
  return candidate;
}

function withinWorkspace(workspace, candidate) {
  const resolved = path.resolve(workspace, candidate);
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    // Missing paths are a legitimate negative result for *-exists checks; resolve the parent.
    try {
      real = path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return null;
    }
  }
  const base = realpathSync(workspace);
  return real === base || real.startsWith(`${base}${path.sep}`) ? real : null;
}

function checkGitClean(workspace) {
  const probe = spawnSync('git', ['-C', workspace, 'status', '--porcelain'], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_EVIDENCE_BYTES
  });
  if (probe.error || probe.status === null) return { ok: false, reason: 'git status could not run (timeout or git missing)' };
  if (probe.status !== 0) return { ok: false, reason: 'not a git worktree' };
  const dirty = probe.stdout.split('\n').filter(Boolean);
  return dirty.length === 0
    ? { ok: true }
    : { ok: false, reason: `worktree has ${dirty.length} uncommitted change(s)` };
}

function checkFileExists(workspace, check) {
  if (!Array.isArray(check.paths) || check.paths.length === 0 || check.paths.length > MAX_PATHS_PER_CHECK) {
    return { ok: false, reason: 'file-exists requires 1-64 paths' };
  }
  const missing = [];
  for (const candidate of check.paths) {
    const relative = safeRelative(candidate);
    if (!relative) return { ok: false, reason: `unsafe path '${String(candidate).slice(0, 80)}'` };
    const resolved = withinWorkspace(workspace, relative);
    if (!resolved) return { ok: false, reason: `path escapes the workspace: ${relative}` };
    if (!existsSync(resolved) || !statSync(resolved).isFile()) missing.push(relative);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, reason: `missing: ${missing.join(', ')}` };
}

function checkEvidenceValid(workspace, check) {
  const relative = safeRelative(check.path || '');
  if (!relative) return { ok: false, reason: 'evidence-valid requires one safe relative path' };
  const resolved = withinWorkspace(workspace, relative);
  if (!resolved) return { ok: false, reason: `path escapes the workspace: ${relative}` };
  if (!existsSync(resolved)) return { ok: false, reason: `evidence file missing: ${relative}` };
  if (statSync(resolved).size > MAX_EVIDENCE_BYTES) return { ok: false, reason: 'evidence file exceeds the 1 MiB bound' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch {
    return { ok: false, reason: 'evidence file is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'evidence root must be an object' };
  const keys = Array.isArray(check.requiredKeys) ? check.requiredKeys : [];
  if (keys.length > MAX_CHECKS) return { ok: false, reason: 'too many required keys' };
  const absent = keys.filter((key) => typeof key === 'string' && !Object.hasOwn(parsed, key));
  return absent.length === 0 ? { ok: true } : { ok: false, reason: `evidence lacks keys: ${absent.join(', ')}` };
}

export function evaluatePreconditions(config, workspace) {
  const checks = Array.isArray(config?.checks) ? config.checks : null;
  if (!checks || checks.length > MAX_CHECKS) return { ok: false, failures: ['config requires 0-32 checks'] };
  const failures = [];
  for (const [index, check] of checks.entries()) {
    const label = `checks[${index}]`;
    if (!check || typeof check !== 'object' || !KNOWN_CHECKS.has(check.type)) {
      failures.push(`${label}: unknown check type '${check?.type}'`);
      continue;
    }
    const result = check.type === 'git-clean'
      ? checkGitClean(workspace)
      : check.type === 'file-exists'
        ? checkFileExists(workspace, check)
        : checkEvidenceValid(workspace, check);
    if (!result.ok) failures.push(`${check.type}: ${result.reason}`);
  }
  return failures.length === 0 ? { ok: true, failures: [] } : { ok: false, failures };
}

export function main(argv = process.argv.slice(2)) {
  const configFlag = argv.indexOf('--config');
  const workspaceFlag = argv.indexOf('--workspace');
  if (configFlag < 0 || !argv[configFlag + 1]) fail('usage', 'usage: command-precondition --config <file> [--workspace <dir>]');
  const workspace = path.resolve(workspaceFlag >= 0 && argv[workspaceFlag + 1] ? argv[workspaceFlag + 1] : process.cwd());
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) fail('usage', `workspace does not exist: ${workspace}`);
  const configPath = path.resolve(argv[configFlag + 1]);
  let real;
  try {
    real = realpathSync(configPath);
  } catch {
    fail('usage', `config file missing: ${configPath}`);
  }
  if (statSync(real).size > MAX_CONFIG_BYTES) fail('config-limit', 'config exceeds the 64 KiB bound');
  let config;
  try {
    config = JSON.parse(readFileSync(real, 'utf8'));
  } catch {
    fail('config-invalid', 'config is not valid JSON');
  }
  const result = evaluatePreconditions(config, workspace);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main();
}
