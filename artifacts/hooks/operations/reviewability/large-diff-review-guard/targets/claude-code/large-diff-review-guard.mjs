#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_FILES = 50;
export const MAX_CHANGED_LINES = 1200;
export const MAX_BINARY_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BINARY_BYTES = 20 * 1024 * 1024;

function commitCommand(value, depth = 0) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024) return 'invalid';
  if (/[\r\n;&|<>]|\$\(|`/.test(value)) return /\bgit\s+commit\b/.test(value) ? 'invalid' : 'other';
  const tokens = value.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])([\s\S]*)\1$/, '$2')) || [];
  let cursor = 0; while (/^[A-Za-z_]\w*=/.test(tokens[cursor] || '')) cursor += 1;
  if (path.basename(tokens[cursor] || '') === 'env') { cursor += 1; while (tokens[cursor] && (tokens[cursor].startsWith('-') || /^[A-Za-z_]\w*=/.test(tokens[cursor]))) cursor += ['-u', '--unset', '-C', '--chdir'].includes(tokens[cursor]) ? 2 : 1; }
  if (path.basename(tokens[cursor] || '') === 'command') { cursor += 1; while (tokens[cursor]?.startsWith('-')) cursor += 1; }
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(path.basename(tokens[cursor] || ''))) { const option = tokens.findIndex((token, index) => index > cursor && /^-[^-]*c/.test(token)); return depth < 3 && option >= 0 && tokens[option + 1] ? commitCommand(tokens[option + 1], depth + 1) : 'invalid'; }
  if (path.basename(tokens[cursor] || '') !== 'git') return 'other';
  cursor += 1; while (tokens[cursor]?.startsWith('-')) { if (['-C', '-c', '--git-dir', '--work-tree'].includes(tokens[cursor]) || /^(?:-C|--git-dir=|--work-tree=)/.test(tokens[cursor])) return 'invalid'; cursor += 1; }
  if (tokens[cursor] !== 'commit' || tokens.includes('--dry-run')) return 'other';
  const options = tokens.slice(cursor + 1);
  if (options.some((token) => token === '--all' || token === '--include' || token === '--only' || token === '-i' || token === '-o' || /^-[^-]*a/.test(token) || token.startsWith('--pathspec-from-file')) || options.includes('--')) return 'invalid';
  return 'commit';
}

function git(cwd, args, maxBuffer = 2 * 1024 * 1024) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer });
  if (result.status !== 0 || result.error) throw new Error('git inspection failed');
  return result.stdout;
}

function measure(cwd) {
  const output = git(cwd, ['diff', '--cached', '--numstat', '-z', '--no-renames']);
  const records = output.split('\0').filter(Boolean);
  const totals = { files: 0, changedLines: 0, binaryBytes: 0, largestBinaryBytes: 0 };
  for (const record of records) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('numstat record malformed');
    totals.files += 1;
    if (totals.files > 10000) throw new Error('file count inspection bound exceeded');
    if (match[1] === '-' || match[2] === '-') {
      const staged = spawnSync('git', ['cat-file', '-s', `:${match[3]}`], { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
      if (staged.status !== 0) {
        const previous = spawnSync('git', ['cat-file', '-e', `HEAD:${match[3]}`], { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
        if (previous.status === 0) continue;
        throw new Error('binary size unavailable');
      }
      if (staged.error) throw new Error('binary size unavailable');
      const sizeText = staged.stdout.trim();
      if (!/^\d+$/.test(sizeText)) throw new Error('binary size unavailable');
      const size = Number(sizeText);
      totals.binaryBytes += size;
      totals.largestBinaryBytes = Math.max(totals.largestBinaryBytes, size);
    } else {
      totals.changedLines += Number(match[1]) + Number(match[2]);
    }
  }
  return totals;
}

export function collectContext(input, cwd = process.cwd()) {
  const command = input?.tool_input?.command ?? input?.toolInput?.command;
  const kind = commitCommand(command);
  if (kind === 'other') return { relevant: false };
  if (kind === 'invalid') return /\bgit\s+commit\b/.test(String(command)) ? { relevant: true, invalid: true } : { relevant: false };
  try {
    const repository = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
    return { relevant: true, totals: measure(repository) };
  } catch { return { relevant: true, invalid: true }; }
}

export function evaluate(_input, context = {}) {
  if (!context.relevant) return { exitCode: 0 };
  if (context.invalid) return { exitCode: 2, ruleId: 'large-diff-inspection-incomplete', message: 'The staged change size could not be measured safely.' };
  const totals = context.totals || {};
  if (totals.files > MAX_FILES) return { exitCode: 2, ruleId: 'large-diff-file-limit', message: 'The staged commit exceeds the fixed file-count review limit.' };
  if (totals.changedLines > MAX_CHANGED_LINES) return { exitCode: 2, ruleId: 'large-diff-line-limit', message: 'The staged commit exceeds the fixed changed-line review limit.' };
  if (totals.largestBinaryBytes > MAX_BINARY_BYTES) return { exitCode: 2, ruleId: 'large-diff-binary-limit', message: 'A staged binary exceeds the fixed per-file review limit.' };
  if (totals.binaryBytes > MAX_TOTAL_BINARY_BYTES) return { exitCode: 2, ruleId: 'large-diff-binary-total-limit', message: 'Staged binaries exceed the fixed aggregate review limit.' };
  return { exitCode: 0 };
}

async function execute() {
  try {
    const pieces = []; let count = 0;
    for await (const piece of process.stdin) { count += piece.length; if (count > MAX_STDIN_BYTES) throw new Error('input exceeds the bounded limit'); pieces.push(piece); }
    const input = JSON.parse(Buffer.concat(pieces).toString('utf8'));
    const result = evaluate(input, collectContext(input));
    if (result.exitCode) process.stderr.write(`[${result.ruleId}] ${result.message}\n`);
    process.exitCode = result.exitCode;
  } catch { process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n'); process.exitCode = 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) execute();
