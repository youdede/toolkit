#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_INDEX_BYTES = 2 * 1024 * 1024;
export const MAX_INDEX_ENTRIES = 20000;
const DECLARATIVE = /(?:^|\.)(?:json|ya?ml|toml|ini|cfg|conf|md|mdx|txt|csv|tsv|xml|html?|css|lock|env)$/i;
const SHEBANG = /^#!\s*(?:\/usr\/bin\/env(?:\s+-S)?\s+(?:node|deno|bun|bash|sh|zsh|python\d*|ruby|perl|php)|\/(?:bin|usr\/bin)\/(?:bash|sh|zsh|node|python\d*|ruby|perl|php))(?:\s|$)/;

function isCommit(command, depth = 0) {
  if (typeof command !== 'string' || Buffer.byteLength(command) > 256 * 1024) return null;
  if (/[\r\n;&|<>]|\$\(|`/.test(command)) return /\bgit\s+commit\b/.test(command) ? 'ambiguous' : null;
  const tokens = command.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])([\s\S]*)\1$/, '$2')) || [];
  let cursor = 0; while (/^[A-Za-z_]\w*=/.test(tokens[cursor] || '')) cursor += 1;
  if (path.basename(tokens[cursor] || '') === 'env') { cursor += 1; while (tokens[cursor] && (tokens[cursor].startsWith('-') || /^[A-Za-z_]\w*=/.test(tokens[cursor]))) cursor += ['-u', '--unset', '-C', '--chdir'].includes(tokens[cursor]) ? 2 : 1; }
  if (path.basename(tokens[cursor] || '') === 'command') { cursor += 1; while (tokens[cursor]?.startsWith('-')) cursor += 1; }
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(path.basename(tokens[cursor] || ''))) { const option = tokens.findIndex((token, index) => index > cursor && /^-[^-]*c/.test(token)); return depth < 3 && option >= 0 && tokens[option + 1] ? isCommit(tokens[option + 1], depth + 1) : 'ambiguous'; }
  if (path.basename(tokens[cursor] || '') !== 'git') return null;
  cursor += 1; while (tokens[cursor]?.startsWith('-')) { if (['-C', '-c', '--git-dir', '--work-tree'].includes(tokens[cursor]) || /^(?:-C|--git-dir=|--work-tree=)/.test(tokens[cursor])) return 'ambiguous'; cursor += 1; }
  if (tokens[cursor] !== 'commit' || tokens.includes('--dry-run')) return null;
  const options = tokens.slice(cursor + 1);
  if (options.some((token) => token === '--all' || token === '--include' || token === '--only' || token === '-i' || token === '-o' || /^-[^-]*a/.test(token) || token.startsWith('--pathspec-from-file')) || options.includes('--')) return 'ambiguous';
  return 'commit';
}

function runGit(cwd, args, limit = MAX_INDEX_BYTES) {
  const result = spawnSync('git', args, { cwd, encoding: 'buffer', timeout: 5000, maxBuffer: limit });
  if (result.status !== 0 || result.error || result.stdout.length > limit) throw new Error('git inspection failed');
  return result.stdout;
}

function indexModes(buffer) {
  const modes = new Map();
  for (const record of buffer.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('index record is malformed');
    if (match[2] === '0') modes.set(match[3], match[1]);
    if (modes.size > MAX_INDEX_ENTRIES) throw new Error('index entry limit exceeded');
  }
  return modes;
}

function headModes(cwd) {
  const present = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000, maxBuffer: 4096 });
  if (present.status !== 0) return new Map();
  const raw = runGit(cwd, ['ls-tree', '-r', '-z', 'HEAD']);
  const modes = new Map();
  for (const record of raw.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6})\s+\w+\s+[a-f0-9]+\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('tree record is malformed');
    modes.set(match[2], match[1]);
  }
  return modes;
}

export function inspectExecutableAddition(file) {
  if (!file || file.newMode !== '100755' || file.oldMode === '100755') return null;
  if (DECLARATIVE.test(file.name)) return { ruleId: 'executable-declarative-file' };
  if (typeof file.prefix !== 'string' || !SHEBANG.test(file.prefix)) return { ruleId: 'executable-shebang-missing' };
  return null;
}

export function collectContext(input, cwd = process.cwd()) {
  const command = input?.tool_input?.command ?? input?.toolInput?.command;
  const intent = isCommit(command);
  if (!intent) return { relevant: false };
  if (intent === 'ambiguous') return { relevant: true, invalid: true };
  try {
    const repository = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
    const current = indexModes(runGit(repository, ['ls-files', '--stage', '-z']));
    const previous = headModes(repository);
    const files = [];
    for (const [name, newMode] of current) {
      const oldMode = previous.get(name);
      if (newMode !== '100755' || oldMode === '100755') continue;
      const blob = runGit(repository, ['show', `:${name}`], MAX_INDEX_BYTES);
      files.push({ name, newMode, oldMode, prefix: blob.subarray(0, 512).toString('utf8') });
    }
    return { relevant: true, files };
  } catch { return { relevant: true, invalid: true }; }
}

export function evaluate(_input, context = {}) {
  if (!context.relevant) return { exitCode: 0 };
  if (context.invalid) return { exitCode: 2, ruleId: 'executable-permission-inspection-incomplete', message: 'Staged executable permissions could not be inspected safely.' };
  for (const file of context.files || []) {
    const violation = inspectExecutableAddition(file);
    if (violation) return { exitCode: 2, ruleId: violation.ruleId, message: 'A staged file gains an executable permission without a supported executable shape.' };
  }
  return { exitCode: 0 };
}

async function main() {
  try {
    const inputParts = []; let inputSize = 0;
    for await (const part of process.stdin) { inputSize += part.length; if (inputSize > MAX_STDIN_BYTES) throw new Error('input exceeds the bounded limit'); inputParts.push(part); }
    const envelope = JSON.parse(Buffer.concat(inputParts).toString('utf8'));
    const outcome = evaluate(envelope, collectContext(envelope));
    if (outcome.exitCode) process.stderr.write(`[${outcome.ruleId}] ${outcome.message}\n`);
    process.exitCode = outcome.exitCode;
  } catch { process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n'); process.exitCode = 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
