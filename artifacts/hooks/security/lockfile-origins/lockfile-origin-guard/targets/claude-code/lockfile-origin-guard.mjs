#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function cleanGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_LOCKFILE_BYTES = 2 * 1024 * 1024;
export const MAX_LOCKFILES = 24;

function words(command) {
  if (typeof command !== 'string' || Buffer.byteLength(command) > 256 * 1024 || /[\r\n;&|<>]|\$\(|`/.test(command)) return null;
  const result = []; let token = ''; let quote = '';
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (quote === '"' && ch === '\\' && i + 1 < command.length) token += command[++i];
      else token += ch;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (/\s/.test(ch)) { if (token) { result.push(token); token = ''; } }
    else if (ch === '\\' && i + 1 < command.length) token += command[++i];
    else token += ch;
  }
  if (quote) return null;
  if (token) result.push(token);
  return result;
}

function normalizedWords(command, depth = 0) {
  const tokens = words(command);
  if (!tokens || depth > 3) return null;
  let cursor = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor] || '')) cursor += 1;
  for (;;) {
    const executable = path.basename(tokens[cursor] || '').toLowerCase();
    if (executable === 'env') {
      cursor += 1;
      while (tokens[cursor] && (tokens[cursor].startsWith('-') || /^[A-Za-z_]\w*=/.test(tokens[cursor]))) {
        if (['-u', '--unset', '-C', '--chdir'].includes(tokens[cursor]) && !tokens[cursor].includes('=')) cursor += 2;
        else cursor += 1;
      }
      continue;
    }
    if (['command', 'nohup'].includes(executable)) { cursor += 1; while (tokens[cursor]?.startsWith('-')) cursor += 1; continue; }
    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(executable)) {
      const option = tokens.findIndex((token, index) => index > cursor && (/^-[^-]*c/.test(token) || token === '--command'));
      return option >= 0 && tokens[option + 1] ? normalizedWords(tokens[option + 1], depth + 1) : null;
    }
    break;
  }
  if (!tokens[cursor]) return null;
  return [path.basename(tokens[cursor]).toLowerCase(), ...tokens.slice(cursor + 1)];
}

function autoStages(commitArgs) {
  return commitArgs.some((token) => token === '--all' || token === '--include' || token === '--only' || token === '-i' || token === '-o' || /^-[^-]*a/.test(token) || token.startsWith('--pathspec-from-file')) || commitArgs.includes('--');
}

export function commitIntent(command) {
  const tokens = normalizedWords(command);
  if (!tokens) return /\bgit\s+commit\b/.test(String(command)) ? 'uninspectable' : 'irrelevant';
  if (tokens[0] !== 'git') return 'irrelevant';
  let index = 1;
  while (tokens[index]?.startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree'].includes(tokens[index])) return 'uninspectable';
    index += 1;
  }
  if (tokens[index] !== 'commit' || tokens.includes('--dry-run')) return 'irrelevant';
  if (autoStages(tokens.slice(index + 1))) return 'uninspectable';
  return 'commit';
}

export function scanPackageLock(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_LOCKFILE_BYTES) throw new Error('staged lockfile exceeds bounds');
  let lockfile;
  try { lockfile = JSON.parse(content); } catch { throw new Error('staged lockfile is malformed'); }
  if (!lockfile || typeof lockfile !== 'object' || Array.isArray(lockfile)) throw new Error('staged lockfile root is invalid');
  const records = [];
  if (lockfile.packages && typeof lockfile.packages === 'object') records.push(...Object.entries(lockfile.packages));
  else {
    const visit = (dependencies, prefix = '', depth = 0) => {
      if (depth > 64 || records.length > 100000) throw new Error('lockfile dependency graph exceeds bounds');
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return;
      for (const [name, record] of Object.entries(dependencies)) {
        records.push([`${prefix}${name}`, record]);
        if (record && typeof record === 'object') visit(record.dependencies, `${prefix}${name}>`, depth + 1);
      }
    };
    visit(lockfile.dependencies || {});
  }
  const findings = [];
  for (const [name, record] of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const resolved = typeof record.resolved === 'string' ? record.resolved.trim() : '';
    if (!resolved || name === '') continue;
    if (/^(?:file|link):|^(?:\.{1,2}[/\\]|[/\\])/i.test(resolved)) findings.push({ ruleId: 'lockfile-local-origin' });
    else if (/^(?:git\+|git:|ssh:)|^git@/i.test(resolved)) findings.push({ ruleId: 'lockfile-git-origin' });
    else if (/^http:\/\//i.test(resolved)) findings.push({ ruleId: 'lockfile-insecure-origin' });
    else if (/^https?:\/\/[^/]*@/i.test(resolved)) findings.push({ ruleId: 'lockfile-credential-origin' });
    else if (/^https:\/\//i.test(resolved) && (typeof record.integrity !== 'string' || !record.integrity.trim())) findings.push({ ruleId: 'lockfile-integrity-missing' });
  }
  return findings;
}

function git(cwd, args, maxBuffer = MAX_LOCKFILE_BYTES + 1024) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer, env: cleanGitEnvironment() });
  if (result.status !== 0 || result.error) throw new Error('git inspection failed');
  return result.stdout;
}

export function collectContext(input, cwd = process.cwd()) {
  const command = input?.tool_input?.command ?? input?.toolInput?.command;
  const intent = commitIntent(command);
  if (intent === 'irrelevant') return { relevant: false };
  if (intent === 'uninspectable') return { relevant: true, invalid: true };
  try {
    const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
    const names = git(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], 256 * 1024)
      .split('\0').filter((name) => /(?:^|\/)package-lock\.json$/i.test(name));
    if (names.length > MAX_LOCKFILES) throw new Error('too many staged lockfiles');
    const staged = names.map((name) => ({ name, content: git(root, ['show', `:${name}`]) }));
    return { relevant: true, staged };
  } catch { return { relevant: true, invalid: true }; }
}

export function evaluate(_input, state = {}) {
  if (!state.relevant) return { exitCode: 0 };
  if (state.invalid) return { exitCode: 2, ruleId: 'lockfile-origin-inspection-incomplete', message: 'Staged lockfile origins could not be inspected safely.' };
  try {
    for (const file of state.staged || []) {
      const finding = scanPackageLock(file.content)[0];
      if (finding) return { exitCode: 2, ruleId: finding.ruleId, message: 'A staged lockfile contains an unsafe or unverifiable dependency origin.' };
    }
    return { exitCode: 0 };
  } catch {
    return { exitCode: 2, ruleId: 'lockfile-origin-input-invalid', message: 'A staged lockfile was malformed or exceeded the bounded limit.' };
  }
}

async function main() {
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > MAX_STDIN_BYTES) throw new Error('input exceeds the bounded limit'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const decision = evaluate(input, collectContext(input));
    if (decision.exitCode) process.stderr.write(`[${decision.ruleId}] ${decision.message}\n`);
    process.exitCode = decision.exitCode;
  } catch { process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n'); process.exitCode = 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
