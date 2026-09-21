#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function nodePublishIntent(command, depth = 0) {
  if (typeof command !== 'string' || Buffer.byteLength(command) > 256 * 1024) return 'invalid';
  if (/[\r\n;&|<>]|\$\(|`/.test(command)) return /\b(?:npm|pnpm)\s+publish\b|\byarn\s+npm\s+publish\b/.test(command) ? 'invalid' : 'other';
  const tokens = command.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])([\s\S]*)\1$/, '$2')) || [];
  let cursor = 0; while (/^[A-Za-z_]\w*=/.test(tokens[cursor] || '')) cursor += 1;
  if (path.basename(tokens[cursor] || '') === 'env') { cursor += 1; while (tokens[cursor] && (tokens[cursor].startsWith('-') || /^[A-Za-z_]\w*=/.test(tokens[cursor]))) cursor += ['-u', '--unset', '-C', '--chdir'].includes(tokens[cursor]) ? 2 : 1; }
  if (path.basename(tokens[cursor] || '') === 'command') { cursor += 1; while (tokens[cursor]?.startsWith('-')) cursor += 1; }
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(path.basename(tokens[cursor] || ''))) { const option = tokens.findIndex((token, index) => index > cursor && /^-[^-]*c/.test(token)); return depth < 3 && option >= 0 && tokens[option + 1] ? nodePublishIntent(tokens[option + 1], depth + 1) : 'invalid'; }
  if (!tokens[cursor]) return 'other';
  const args = [path.basename(tokens[cursor]).toLowerCase(), ...tokens.slice(cursor + 1)];
  if (args.includes('--dry-run') || args.includes('--dry-run=true')) return 'other';
  const publishIndex = args.indexOf('publish', 1);
  if (['npm', 'pnpm'].includes(args[0]) && publishIndex >= 1) {
    const positional = args.slice(publishIndex + 1).filter((token) => !token.startsWith('-'));
    if (positional.length || args.some((token) => /^(?:--workspace|-w|--filter)(?:=|$)/.test(token))) return 'invalid';
    return 'publish';
  }
  if (args[0] === 'yarn' && args.includes('npm') && publishIndex >= 2) return args.some((token) => /^(?:--workspace|-w)(?:=|$)/.test(token)) ? 'invalid' : 'publish';
  return 'other';
}

function boundedJson(file) {
  const status = lstatSync(file);
  if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_METADATA_BYTES) throw new Error('unsafe package metadata');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('metadata root is invalid');
  return parsed;
}

export function inspectVersionState(state) {
  if (!state || typeof state !== 'object') return { ruleId: 'release-version-input-invalid' };
  if (state.private === true) return { ruleId: 'release-package-private' };
  if (typeof state.name !== 'string' || !state.name.trim() || /^(?:package|my-package|example)$/i.test(state.name.trim())) return { ruleId: 'release-package-name-invalid' };
  if (typeof state.version !== 'string' || !SEMVER.test(state.version) || /^0\.0\.0(?:-|$)/.test(state.version)) return { ruleId: 'release-version-invalid' };
  if (!Array.isArray(state.lockVersions) || state.lockVersions.length === 0) return { ruleId: 'release-lock-version-missing' };
  if (state.lockVersions.some((version) => version !== state.version)) return { ruleId: 'release-version-mismatch' };
  return null;
}

export function collectContext(input, cwd = process.cwd()) {
  const command = input?.tool_input?.command ?? input?.toolInput?.command;
  const intent = nodePublishIntent(command);
  if (intent === 'other') return { relevant: false };
  if (intent === 'invalid') return /\bpublish\b/.test(String(command)) ? { relevant: true, invalid: true } : { relevant: false };
  try {
    const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
    const manifest = boundedJson(path.join(root, 'package.json'));
    let lock = null;
    for (const name of ['npm-shrinkwrap.json', 'package-lock.json']) {
      try { lock = boundedJson(path.join(root, name)); break; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    const lockVersions = [];
    if (lock) {
      if (typeof lock.version === 'string') lockVersions.push(lock.version);
      if (typeof lock.packages?.['']?.version === 'string') lockVersions.push(lock.packages[''].version);
    }
    return { relevant: true, state: { name: manifest.name, version: manifest.version, private: manifest.private, lockVersions: [...new Set(lockVersions)] } };
  } catch { return { relevant: true, invalid: true }; }
}

export function evaluate(_input, context = {}) {
  if (!context.relevant) return { exitCode: 0 };
  if (context.invalid) return { exitCode: 2, ruleId: 'release-version-inspection-incomplete', message: 'Release package metadata could not be inspected safely.' };
  const finding = inspectVersionState(context.state);
  return finding
    ? { exitCode: 2, ruleId: finding.ruleId, message: 'Package and lockfile metadata are not consistent for publication.' }
    : { exitCode: 0 };
}

async function run() {
  try {
    const chunks = []; let total = 0;
    for await (const chunk of process.stdin) { total += chunk.length; if (total > MAX_STDIN_BYTES) throw new Error('input exceeds the bounded limit'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const verdict = evaluate(input, collectContext(input));
    if (verdict.exitCode) process.stderr.write(`[${verdict.ruleId}] ${verdict.message}\n`);
    process.exitCode = verdict.exitCode;
  } catch { process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n'); process.exitCode = 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
