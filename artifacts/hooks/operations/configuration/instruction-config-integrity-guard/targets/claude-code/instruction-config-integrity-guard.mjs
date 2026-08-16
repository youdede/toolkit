#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_CONFIG_BYTES = 512 * 1024;

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function allow(ruleId = 'instruction-config-integrity-clear', message = '') {
  return { exitCode: 0, ruleId, message };
}

function block(ruleId, detail) {
  return { exitCode: 2, ruleId, message: `BLOCKED by instruction-config-integrity-guard [${ruleId}]: ${detail}.` };
}

export function collectContext(input, defaultCwd = process.cwd()) {
  const file = input?.file_path;
  const cwd = input?.cwd || defaultCwd;
  if (typeof file !== 'string' || typeof cwd !== 'string' || !path.isAbsolute(file)) {
    return { inspectionError: 'path-missing' };
  }
  try {
    const root = realpathSync(cwd);
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return { inspectionError: 'path-unsafe' };
    const resolved = realpathSync(file);
    const pathInsideProject = within(root, resolved);
    if (input.hook_event_name !== 'ConfigChange') return { pathInsideProject };
    if (metadata.size > MAX_CONFIG_BYTES) return { pathInsideProject, inspectionError: 'config-oversized' };
    let config;
    try { config = JSON.parse(readFileSync(resolved, 'utf8')); }
    catch { return { pathInsideProject, inspectionError: 'config-invalid' }; }
    return { pathInsideProject, config };
  } catch {
    return { inspectionError: 'path-unreadable' };
  }
}

export function evaluate(input, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return block('instruction-config-envelope-invalid', 'the hook envelope is invalid');
  }
  if (input.hook_event_name === 'InstructionsLoaded') {
    if (!['Project', 'Local'].includes(input.memory_type)) return allow('instruction-scope-irrelevant');
    if (context.inspectionError || context.pathInsideProject !== true) {
      return allow(
        'instruction-boundary-observed',
        'OBSERVED by instruction-config-integrity-guard [instruction-boundary-observed]: a project instruction path could not be verified inside the active project.'
      );
    }
    return allow('instruction-boundary-clear');
  }
  if (input.hook_event_name !== 'ConfigChange') return allow('instruction-config-event-irrelevant');
  if (input.source === 'policy_settings') return allow('managed-policy-not-blockable');
  if (!['project_settings', 'local_settings'].includes(input.source)) return allow('config-scope-irrelevant');
  if (context.inspectionError || context.pathInsideProject !== true || !context.config || Array.isArray(context.config)) {
    return block('config-change-unverified', 'the changed project configuration cannot be verified as a bounded JSON file');
  }
  const config = context.config;
  if (config.disableAllHooks === true) return block('config-hooks-disabled', 'the change disables project hook enforcement');
  if (config.permissions?.defaultMode === 'bypassPermissions') {
    return block('config-permission-bypass-default', 'the change makes bypassPermissions the default mode');
  }
  if (config.permissions?.disableBypassPermissionsMode === false) {
    return block('config-permission-bypass-enabled', 'the change explicitly enables bypassPermissions mode');
  }
  if (config.allowManagedHooksOnly === false) {
    return block('config-managed-hook-policy-weakened', 'the change explicitly weakens managed-hook-only enforcement');
  }
  return allow('config-integrity-clear');
}

async function receiveEnvelope() {
  const chunks = [];
  let received = 0;
  for await (const chunk of process.stdin) {
    received += chunk.length;
    if (received > MAX_STDIN_BYTES) throw new Error('configuration input exceeds the bounded size');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw.trim() ? JSON.parse(raw) : {}; }
  catch { throw new Error('configuration input is not valid JSON'); }
}

async function runHook() {
  let decision;
  try {
    const input = await receiveEnvelope();
    decision = evaluate(input, collectContext(input));
  } catch (error) {
    decision = block('instruction-config-envelope-invalid', error.message);
  }
  if (decision.message) process.stderr.write(`${decision.message}\n`);
  process.exitCode = decision.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
