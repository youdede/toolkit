#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectTrackedPaths,
  scanGitHistory,
  scanWorkspacePaths,
  sortFindings
} from './lib/secret-scan.mjs';
import { resolveNpmPackInvocation } from './verify-package-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_ARGUMENTS = new Set(['--tracked', '--package', '--history', '--json']);

function fail(message) {
  process.stderr.write(`Secret verification failed: ${message}\n`);
  process.exitCode = 1;
}

function collectPackagePaths(root) {
  const invocation = resolveNpmPackInvocation();
  const packed = spawnSync(invocation.command, invocation.argumentsList, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: invocation.shell,
    windowsHide: true
  });
  if (packed.status !== 0) {
    const status = Number.isInteger(packed.status) ? `exit ${packed.status}` : (packed.error?.code ?? 'spawn failure');
    throw new Error(`npm pack --dry-run did not complete (${status})`);
  }
  let result;
  try {
    result = JSON.parse(packed.stdout);
  } catch (error) {
    throw new Error(`npm returned malformed pack metadata: ${error.message}`);
  }
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].files)) {
    throw new Error('npm returned an unsupported pack result');
  }
  return result[0].files.map((entry) => String(entry.path).replaceAll('\\', '/'));
}

function addPaths(records, paths, scope) {
  for (const file of paths) {
    if (!records.has(file)) records.set(file, { path: file, scopes: [] });
    records.get(file).scopes.push(scope);
  }
}

export function verifySecrets({ root = ROOT, tracked = true, packageFiles = true, history = false } = {}) {
  const records = new Map();
  const scopes = [];
  if (tracked) {
    addPaths(records, collectTrackedPaths(root), 'tracked');
    scopes.push('tracked');
  }
  if (packageFiles) {
    addPaths(records, collectPackagePaths(root), 'package');
    scopes.push('package');
  }

  const workspace = scanWorkspacePaths(root, records.values());
  const historical = history
    ? scanGitHistory(root)
    : { files: 0, textFiles: 0, binaryFiles: 0, findings: [] };
  if (history) scopes.push('history');
  return {
    schemaVersion: 1,
    scopes,
    files: workspace.files + historical.files,
    textFiles: workspace.textFiles + historical.textFiles,
    binaryFiles: workspace.binaryFiles + historical.binaryFiles,
    valid: workspace.findings.length === 0 && historical.findings.length === 0,
    findings: sortFindings([...workspace.findings, ...historical.findings])
  };
}

function run() {
  const argumentsList = process.argv.slice(2);
  const unknown = argumentsList.filter((argument) => !ALLOWED_ARGUMENTS.has(argument));
  if (unknown.length > 0) {
    fail('unsupported argument');
    return;
  }
  const explicitScope = argumentsList.some((argument) => ['--tracked', '--package', '--history'].includes(argument));
  let result;
  try {
    result = verifySecrets({
      tracked: explicitScope ? argumentsList.includes('--tracked') : true,
      packageFiles: explicitScope ? argumentsList.includes('--package') : true,
      history: argumentsList.includes('--history')
    });
  } catch (error) {
    fail(error.message);
    return;
  }

  if (argumentsList.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.valid) {
    process.stdout.write(`Secret scan passed for ${result.files} inputs across ${result.scopes.join(', ')}; values are never printed.\n`);
  } else {
    process.stderr.write(`Secret scan found ${result.findings.length} blocked input(s); matched values are redacted.\n`);
    for (const item of result.findings) {
      process.stderr.write(`- ${item.ruleId} ${JSON.stringify(item.path)}:${item.line} (${item.scope})\n`);
    }
  }
  process.exitCode = result.valid ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
