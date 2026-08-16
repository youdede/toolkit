#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_STATUS_BYTES = 2 * 1024 * 1024;

function tokenize(command) {
  if (typeof command !== 'string' || Buffer.byteLength(command) > 256 * 1024 || /[\r\n;&|<>]|\$\(|`/.test(command)) return null;
  const tokens = []; let token = ''; let quote = '';
  for (let offset = 0; offset < command.length; offset += 1) {
    const character = command[offset];
    if (quote) {
      if (character === quote) quote = '';
      else if (quote === '"' && character === '\\' && offset + 1 < command.length) token += command[++offset];
      else token += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) { if (token) { tokens.push(token); token = ''; } }
    else token += character;
  }
  if (quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

function normalizeCommand(command, depth = 0) {
  const tokens = tokenize(command);
  if (!tokens || depth > 3) return null;
  let cursor = 0; while (/^[A-Za-z_]\w*=/.test(tokens[cursor] || '')) cursor += 1;
  if (path.basename(tokens[cursor] || '') === 'env') { cursor += 1; while (tokens[cursor] && (tokens[cursor].startsWith('-') || /^[A-Za-z_]\w*=/.test(tokens[cursor]))) cursor += ['-u', '--unset', '-C', '--chdir'].includes(tokens[cursor]) ? 2 : 1; }
  if (path.basename(tokens[cursor] || '') === 'command') { cursor += 1; while (tokens[cursor]?.startsWith('-')) cursor += 1; }
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(path.basename(tokens[cursor] || ''))) { const option = tokens.findIndex((token, index) => index > cursor && /^-[^-]*c/.test(token)); return option >= 0 && tokens[option + 1] ? normalizeCommand(tokens[option + 1], depth + 1) : null; }
  if (!tokens[cursor]) return null;
  return [path.basename(tokens[cursor]).toLowerCase(), ...tokens.slice(cursor + 1)];
}

export function releaseIntent(command) {
  const args = normalizeCommand(command);
  if (!args) return /\b(?:npm|pnpm|cargo)\s+publish\b|\b(?:twine\s+upload|gh\s+release\s+create)\b/.test(String(command)) ? 'uninspectable' : 'irrelevant';
  const commandArgs = args;
  const dryRun = commandArgs.includes('--dry-run') || commandArgs.includes('--dry-run=true');
  const publishIndex = commandArgs.indexOf('publish', 1);
  if (dryRun && (['npm', 'pnpm', 'cargo'].includes(commandArgs[0]) || (commandArgs[0] === 'yarn' && commandArgs.includes('npm'))) && publishIndex >= 1) return 'irrelevant';
  if (['npm', 'pnpm', 'cargo'].includes(commandArgs[0]) && publishIndex >= 1) return 'release';
  if (commandArgs[0] === 'yarn' && commandArgs.includes('npm') && publishIndex >= 2) return 'release';
  if (commandArgs[0] === 'twine' && commandArgs[1] === 'upload') return 'release';
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(commandArgs[0] || '') && commandArgs[1] === '-m' && commandArgs[2] === 'twine' && commandArgs[3] === 'upload') return 'release';
  if (commandArgs[0] === 'gh' && commandArgs[1] === 'release' && commandArgs[2] === 'create') return 'release';
  return 'irrelevant';
}

function git(cwd, args, allowedFailure = false) {
  const outcome = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: MAX_STATUS_BYTES });
  if (outcome.error || (!allowedFailure && outcome.status !== 0)) throw new Error('git state unavailable');
  return outcome;
}

function repositoryState(cwd) {
  git(cwd, ['rev-parse', '--is-inside-work-tree']);
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout;
  const branchResult = git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], true);
  const gitDirectory = git(cwd, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
    .some((name) => existsSync(path.join(gitDirectory, name)));
  return { dirty: status.length > 0, detached: branchResult.status !== 0, operationInProgress: operations };
}

export function collectContext(input, cwd = process.cwd()) {
  const command = input?.tool_input?.command ?? input?.toolInput?.command;
  const intent = releaseIntent(command);
  if (intent === 'irrelevant') return { relevant: false };
  if (intent === 'uninspectable') return { relevant: true, invalid: true };
  try {
    const repository = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
    return { relevant: true, state: repositoryState(repository) };
  } catch { return { relevant: true, invalid: true }; }
}

export function evaluate(_input, context = {}) {
  if (!context.relevant) return { exitCode: 0 };
  if (context.invalid) return { exitCode: 2, ruleId: 'release-state-inspection-incomplete', message: 'Release repository state could not be inspected safely.' };
  if (context.state?.operationInProgress) return { exitCode: 2, ruleId: 'release-operation-in-progress', message: 'A repository operation is still in progress.' };
  if (context.state?.detached) return { exitCode: 2, ruleId: 'release-detached-head', message: 'Release publication requires an attached Git branch.' };
  if (context.state?.dirty) return { exitCode: 2, ruleId: 'release-worktree-dirty', message: 'Release publication requires a clean Git worktree and index.' };
  return { exitCode: 0 };
}

async function main() {
  try {
    const blocks = []; let amount = 0;
    for await (const block of process.stdin) { amount += block.length; if (amount > MAX_STDIN_BYTES) throw new Error('input exceeds the bounded limit'); blocks.push(block); }
    const input = JSON.parse(Buffer.concat(blocks).toString('utf8'));
    const response = evaluate(input, collectContext(input));
    if (response.exitCode) process.stderr.write(`[${response.ruleId}] ${response.message}\n`);
    process.exitCode = response.exitCode;
  } catch { process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n'); process.exitCode = 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
