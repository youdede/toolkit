#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function cleanGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;

function lex(command) {
  if (typeof command !== 'string' || Buffer.byteLength(command) > MAX_COMMAND_BYTES || /[\r\n;&|<>]|\$\(|`/.test(command)) return null;
  const output = []; let current = ''; let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const value = command[index];
    if (quote) {
      if (value === quote) quote = '';
      else if (quote === '"' && value === '\\' && index + 1 < command.length) current += command[++index];
      else current += value;
    } else if (value === "'" || value === '"') quote = value;
    else if (/\s/.test(value)) { if (current) { output.push(current); current = ''; } }
    else if (value === '\\' && index + 1 < command.length) current += command[++index];
    else current += value;
  }
  if (quote) return null;
  if (current) output.push(current);
  return output;
}

export function signingIntent(command, depth = 0) {
  const tokens = lex(command);
  if (!tokens) return /\bgit\s+commit\b/.test(String(command)) ? { relevant: true, invalid: true } : { relevant: false };
  let cursor = 0; while (/^[A-Za-z_]\w*=/.test(tokens[cursor] || '')) cursor += 1;
  if (path.basename(tokens[cursor] || '') === 'env') { cursor += 1; while (tokens[cursor] && (tokens[cursor].startsWith('-') || /^[A-Za-z_]\w*=/.test(tokens[cursor]))) cursor += ['-u', '--unset', '-C', '--chdir'].includes(tokens[cursor]) ? 2 : 1; }
  if (path.basename(tokens[cursor] || '') === 'command') { cursor += 1; while (tokens[cursor]?.startsWith('-')) cursor += 1; }
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(path.basename(tokens[cursor] || ''))) { const option = tokens.findIndex((token, index) => index > cursor && /^-[^-]*c/.test(token)); return depth < 3 && option >= 0 && tokens[option + 1] ? signingIntent(tokens[option + 1], depth + 1) : { relevant: true, invalid: true }; }
  if (path.basename(tokens[cursor] || '') !== 'git') return { relevant: false };
  cursor += 1;
  while (tokens[cursor]?.startsWith('-') && tokens[cursor] !== '--') {
    if (['-C', '-c', '--git-dir', '--work-tree'].includes(tokens[cursor]) || /^(?:-C|--git-dir=|--work-tree=)/.test(tokens[cursor])) {
      return tokens.includes('commit') ? { relevant: true, invalid: true } : { relevant: false };
    }
    cursor += 1;
  }
  if (tokens[cursor] !== 'commit' || tokens.includes('--dry-run')) return { relevant: false };
  const options = tokens.slice(cursor + 1);
  if (options.includes('--no-gpg-sign')) return { relevant: true, explicitDisable: true };
  const explicit = options.some((item) => item === '-S' || item === '--gpg-sign' || /^-S.+/.test(item) || /^--gpg-sign=.+/.test(item));
  return { relevant: true, explicit };
}

export function collectContext(input, cwd = process.cwd()) {
  const command = input?.tool_input?.command ?? input?.toolInput?.command;
  const intent = signingIntent(command);
  if (!intent.relevant || intent.invalid || intent.explicitDisable || intent.explicit) return intent;
  try {
    const repository = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
    const configured = spawnSync('git', ['config', '--bool', '--get', 'commit.gpgSign'], {
      cwd: repository, encoding: 'utf8', timeout: 3000, maxBuffer: 4096,
      env: cleanGitEnvironment()
    });
    if (configured.error || ![0, 1].includes(configured.status)) throw new Error('git config inspection failed');
    return { ...intent, configured: configured.status === 0 && configured.stdout.trim() === 'true' };
  } catch { return { relevant: true, invalid: true }; }
}

export function evaluate(_input, context = {}) {
  if (!context.relevant) return { exitCode: 0 };
  if (context.invalid) return { exitCode: 2, ruleId: 'commit-signature-intent-uninspectable', message: 'Git commit signing intent could not be inspected safely.' };
  if (context.explicitDisable) return { exitCode: 2, ruleId: 'commit-signature-disabled', message: 'The Git commit explicitly disables signature creation.' };
  if (!context.explicit && !context.configured) return { exitCode: 2, ruleId: 'commit-signature-intent-missing', message: 'The Git commit has no explicit or configured signing intent.' };
  return { exitCode: 0 };
}

async function main() {
  try {
    const fragments = []; let size = 0;
    for await (const fragment of process.stdin) { size += fragment.length; if (size > MAX_STDIN_BYTES) throw new Error('input exceeds the bounded limit'); fragments.push(fragment); }
    const input = JSON.parse(Buffer.concat(fragments).toString('utf8'));
    const answer = evaluate(input, collectContext(input));
    if (answer.exitCode) process.stderr.write(`[${answer.ruleId}] ${answer.message}\n`);
    process.exitCode = answer.exitCode;
  } catch { process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n'); process.exitCode = 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
