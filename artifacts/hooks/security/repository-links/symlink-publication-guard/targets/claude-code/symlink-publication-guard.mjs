#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_INDEX_BYTES = 1024 * 1024;
export const MAX_LINK_BYTES = 4096;
export const MAX_LINKS = 256;

function directCommit(command, depth = 0) {
  if (typeof command !== 'string' || Buffer.byteLength(command) > 256 * 1024) return false;
  if (/[\r\n;&|<>]|\$\(|`/.test(command)) return /\bgit\s+commit\b/.test(command) ? null : false;
  const tokens = command.match(/(?:[^\s"']+|"(?:\\.|[^"])*"|'[^']*')+/g)?.map((token) => token.replace(/^(['"])([\s\S]*)\1$/, '$2')) || [];
  let cursor = 0;
  while (/^[A-Za-z_]\w*=/.test(tokens[cursor] || '')) cursor += 1;
  if (path.basename(tokens[cursor] || '') === 'env') { cursor += 1; while (tokens[cursor] && (tokens[cursor].startsWith('-') || /^[A-Za-z_]\w*=/.test(tokens[cursor]))) cursor += ['-u', '--unset', '-C', '--chdir'].includes(tokens[cursor]) ? 2 : 1; }
  if (path.basename(tokens[cursor] || '') === 'command') { cursor += 1; while (tokens[cursor]?.startsWith('-')) cursor += 1; }
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(path.basename(tokens[cursor] || ''))) { const option = tokens.findIndex((token, index) => index > cursor && /^-[^-]*c/.test(token)); return depth < 3 && option >= 0 && tokens[option + 1] ? directCommit(tokens[option + 1], depth + 1) : null; }
  if (path.basename(tokens[cursor] || '') !== 'git') return false;
  cursor += 1;
  while (tokens[cursor]?.startsWith('-')) { if (['-C', '-c', '--git-dir', '--work-tree'].includes(tokens[cursor]) || /^(?:-C|--git-dir=|--work-tree=)/.test(tokens[cursor])) return null; cursor += 1; }
  if (tokens[cursor] !== 'commit' || tokens.includes('--dry-run')) return false;
  const options = tokens.slice(cursor + 1);
  if (options.some((token) => token === '--all' || token === '--include' || token === '--only' || token === '-i' || token === '-o' || /^-[^-]*a/.test(token) || token.startsWith('--pathspec-from-file')) || options.includes('--')) return null;
  return true;
}

export function inspectLinkTarget(repositoryPath, target) {
  if (typeof repositoryPath !== 'string' || typeof target !== 'string') return { ruleId: 'symlink-record-invalid' };
  if (!target || Buffer.byteLength(target) > MAX_LINK_BYTES || /[\0\r\n]/.test(target)) return { ruleId: 'symlink-target-invalid' };
  if (target.includes('\\')) return { ruleId: 'symlink-target-ambiguous' };
  if (path.posix.isAbsolute(target)) return { ruleId: 'symlink-target-absolute' };
  const parent = path.posix.dirname(repositoryPath);
  const normalized = path.posix.normalize(path.posix.join(parent, target));
  if (normalized === '..' || normalized.startsWith('../')) return { ruleId: 'symlink-target-escape' };
  return null;
}

function gitRead(cwd, argumentsList, cap) {
  const result = spawnSync('git', argumentsList, { cwd, encoding: 'buffer', timeout: 5000, maxBuffer: cap });
  if (result.status !== 0 || result.error || result.stdout.length > cap) throw new Error('git inspection failed');
  return result.stdout;
}

function stagedLinks(cwd) {
  const raw = gitRead(cwd, ['ls-files', '--stage', '-z'], MAX_INDEX_BYTES);
  const links = [];
  for (const record of raw.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('staged index record is malformed');
    if (match[1] !== '120000' || match[3] !== '0') continue;
    links.push(match[4]);
    if (links.length > MAX_LINKS) throw new Error('staged symlink count exceeds bound');
  }
  return links.map((name) => {
    const value = gitRead(cwd, ['show', `:${name}`], MAX_LINK_BYTES + 1);
    if (value.length > MAX_LINK_BYTES) throw new Error('symlink target exceeds bound');
    return { name, target: value.toString('utf8') };
  });
}

export function collectContext(input, cwd = process.cwd()) {
  const command = input?.tool_input?.command ?? input?.toolInput?.command;
  const intent = directCommit(command);
  if (intent === false) return { relevant: false };
  if (intent === null) return { relevant: true, invalid: true };
  try {
    const repository = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
    return { relevant: true, links: stagedLinks(repository) };
  } catch { return { relevant: true, invalid: true }; }
}

export function evaluate(_input, context = {}) {
  if (!context.relevant) return { exitCode: 0 };
  if (context.invalid) return { exitCode: 2, ruleId: 'symlink-publication-inspection-incomplete', message: 'Staged symbolic links could not be inspected safely.' };
  for (const link of context.links || []) {
    const finding = inspectLinkTarget(link.name, link.target);
    if (finding) return { exitCode: 2, ruleId: finding.ruleId, message: 'A staged symbolic link has an escaping or ambiguous target.' };
  }
  return { exitCode: 0 };
}

async function invoke() {
  try {
    const data = []; let length = 0;
    for await (const part of process.stdin) { length += part.length; if (length > MAX_STDIN_BYTES) throw new Error('input exceeds the bounded limit'); data.push(part); }
    const input = JSON.parse(Buffer.concat(data).toString('utf8'));
    const result = evaluate(input, collectContext(input));
    if (result.exitCode) process.stderr.write(`[${result.ruleId}] ${result.message}\n`);
    process.exitCode = result.exitCode;
  } catch { process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n'); process.exitCode = 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) invoke();
