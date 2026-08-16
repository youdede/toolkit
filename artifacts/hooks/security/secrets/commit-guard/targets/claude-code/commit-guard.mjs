#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;

const SHELL_EXECUTABLES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

function expansionEnd(source, start) {
  if (source[start] === '`') {
    for (let index = start + 1; index < source.length; index += 1) {
      if (source[index] === '\\') index += 1;
      else if (source[index] === '`') return index + 1;
    }
    return -1;
  }
  const next = source[start + 1];
  if (next !== '(' && next !== '{') {
    const match = /^\$[A-Za-z_][A-Za-z0-9_]*|^\$[0-9@*#?$!_-]/.exec(source.slice(start));
    return match ? start + match[0].length : start + 1;
  }
  const open = next;
  const close = open === '(' ? ')' : '}';
  let depth = 1;
  let quote = null;
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close && --depth === 0) return index + 1;
  }
  return -1;
}

function lexShell(source) {
  const commands = [];
  let tokens = [];
  let token = null;
  let quote = null;
  const begin = () => { if (!token) token = { value: '', dynamic: false }; };
  const pushToken = () => { if (token) tokens.push(token); token = null; };
  const pushCommand = () => { pushToken(); if (tokens.length) commands.push(tokens); tokens = []; };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else token.value += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === '\\') {
        if (++index >= source.length) return { error: 'trailing escape' };
        token.value += source[index];
      } else if (character === '$' || character === '`') {
        const end = expansionEnd(source, index);
        if (end < 0) return { error: 'unterminated expansion' };
        token.value += source.slice(index, end);
        token.dynamic = true;
        index = end - 1;
      } else token.value += character;
      continue;
    }
    if (/\s/.test(character)) {
      pushToken();
      if (character === '\n') pushCommand();
    } else if (character === "'" || character === '"') {
      begin();
      quote = character;
    } else if (character === '\\') {
      begin();
      if (++index >= source.length) return { error: 'trailing escape' };
      token.value += source[index];
    } else if (character === '$' || character === '`') {
      begin();
      const end = expansionEnd(source, index);
      if (end < 0) return { error: 'unterminated expansion' };
      token.value += source.slice(index, end);
      token.dynamic = true;
      index = end - 1;
    } else if (';&|()'.includes(character)) {
      pushCommand();
      if ((character === '&' || character === '|') && source[index + 1] === character) index += 1;
    } else {
      begin();
      token.value += character;
      if (character === '{' || character === '}') token.dynamic = true;
    }
  }
  if (quote) return { error: 'unterminated quote' };
  pushCommand();
  return { commands };
}

function executableName(token) {
  return token.value.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
}

function unwrapCommand(tokens, depth) {
  let index = 0;
  const wrappers = [];
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index].value)) {
    if (/^(?:PATH|SHELL|GIT_DIR|GIT_WORK_TREE|GIT_CONFIG[^=]*)=/.test(tokens[index].value)) return [{ ambiguous: true, wrappers }];
    index += 1;
  }
  for (let count = 0; count < 16 && index < tokens.length; count += 1) {
    const executable = tokens[index];
    if (executable.dynamic || /[*?[]/.test(executable.value)) return [{ ambiguous: true, wrappers }];
    const name = executableName(executable);
    if (SHELL_EXECUTABLES.has(name)) {
      let payload = -1;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const option = tokens[cursor];
        if (option.dynamic) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
        if (option.value === '-c' || option.value === '--command' || /^-[^-]*c[^-]*$/.test(option.value)) {
          payload = cursor + 1;
          break;
        }
        if (!option.value.startsWith('-')) break;
      }
      if (payload < 0) return [{ tokens: tokens.slice(index), wrappers }];
      if (!tokens[payload] || depth >= 3) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
      const nested = normalizeShellCommands(tokens[payload].value, depth + 1);
      return nested.error ? [{ ambiguous: true, wrappers: [...wrappers, name] }] : nested.commands;
    }
    if (name === 'eval') {
      if (!tokens[index + 1] || depth >= 3) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
      const nested = normalizeShellCommands(tokens.slice(index + 1).map((entry) => entry.value).join(' '), depth + 1);
      return nested.error ? [{ ambiguous: true, wrappers: [...wrappers, name] }] : nested.commands;
    }
    if (!['exec', 'time', 'noglob', 'command', 'env', 'sudo', 'nohup'].includes(name)) {
      return [{ tokens: tokens.slice(index), wrappers }];
    }
    wrappers.push(name);
    index += 1;
    if (name === 'command' && ['-v', '-V'].includes(tokens[index]?.value)) return [{ tokens: tokens.slice(index - 1), wrappers: wrappers.slice(0, -1) }];
    while (index < tokens.length) {
      const option = tokens[index];
      if (option.dynamic) return [{ ambiguous: true, wrappers }];
      if (option.value === '--') { index += 1; break; }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(option.value)) {
        if (/^(?:PATH|SHELL|GIT_DIR|GIT_WORK_TREE|GIT_CONFIG[^=]*)=/.test(option.value)) return [{ ambiguous: true, wrappers }];
        index += 1;
        continue;
      }
      if (!option.value.startsWith('-')) break;
      if (name === 'env') {
        if (/^(?:-S|--split-string|-C|--chdir|-a|--argv0)(?:=|$)/.test(option.value)) return [{ ambiguous: true, wrappers }];
        if (/^(?:-u|--unset)$/.test(option.value)) { index += 2; continue; }
        if (/^(?:-u.+|--unset=.+|-i|--ignore-environment|-0|--null|-v|--debug)$/.test(option.value)) { index += 1; continue; }
        return [{ ambiguous: true, wrappers }];
      }
      if (name === 'sudo' && /^(?:-D|--chdir|-R|--chroot)(?:=|$)/.test(option.value)) return [{ ambiguous: true, wrappers }];
      const takesValue = (name === 'sudo' && /^(?:-u|-g|-h|-p|-C|-T|-r|-t)$/.test(option.value))
        || (name === 'time' && /^(?:-f|-o|--format|--output)$/.test(option.value))
        || (name === 'exec' && option.value === '-a');
      const safeNoValue = (name === 'sudo' && /^(?:-[AbEHKnS]+|--(?:askpass|background|preserve-env|edit|set-home|remove-timestamp|reset-timestamp|non-interactive|stdin|validate))$/.test(option.value))
        || (name === 'sudo' && /^--(?:user|group|host|prompt|close-from|command-timeout|role|type)=.+/.test(option.value))
        || (name === 'time' && /^(?:-a|-p|-v|--append|--portability|--verbose|--quiet|--format=.+|--output=.+)$/.test(option.value))
        || (name === 'exec' && /^(?:-c|-l)$/.test(option.value))
        || (name === 'command' && option.value === '-p');
      if (takesValue) { index += 2; continue; }
      if (safeNoValue) { index += 1; continue; }
      return [{ ambiguous: true, wrappers }];
    }
  }
  if (index < tokens.length && ['exec', 'time', 'noglob', 'command', 'env', 'sudo', 'nohup'].includes(executableName(tokens[index]))) {
    return [{ ambiguous: true, wrappers }];
  }
  return index < tokens.length ? [{ tokens: tokens.slice(index), wrappers }] : [{ ambiguous: true, wrappers }];
}

export function normalizeShellCommands(command, depth = 0) {
  if (typeof command !== 'string') return { commands: [] };
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) return { error: 'command exceeds analysis limit', commands: [] };
  const lexed = lexShell(command);
  if (lexed.error) return { error: lexed.error, commands: [] };
  return { commands: lexed.commands.flatMap((tokens) => unwrapCommand(tokens, depth)) };
}

function analyzeCommit(command) {
  const normalized = normalizeShellCommands(command);
  if (normalized.error || normalized.commands.some((entry) => entry.ambiguous)) return { ambiguous: true };
  let changedDirectory = false;
  for (const entry of normalized.commands) {
    if (!entry.tokens?.length) continue;
    const executable = executableName(entry.tokens[0]);
    if (executable === 'cd' || executable === 'pushd') { changedDirectory = true; continue; }
    if (executable !== 'git') continue;
    let index = 1;
    let unsupportedScope = changedDirectory;
    while (index < entry.tokens.length) {
      const token = entry.tokens[index];
      if (token.dynamic) return { ambiguous: true };
      const value = token.value;
      if (value === '--') { index += 1; break; }
      if (!value.startsWith('-')) break;
      if (/^(?:-C|--git-dir|--work-tree)(?:=|$)/.test(value)) unsupportedScope = true;
      const takesValue = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'].includes(value);
      index += takesValue ? 2 : 1;
    }
    const subcommand = entry.tokens[index];
    if (subcommand?.dynamic) return { ambiguous: true };
    if (subcommand?.value === 'commit') return { found: true, unsupportedScope, tokens: entry.tokens.slice(index + 1) };
  }
  return { found: false };
}

const SECRET_RULES = [
  { id: 'private-key', label: 'private key block', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', label: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: 'github-token', label: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { id: 'anthropic-key', label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'openai-key', label: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { id: 'stripe-live-key', label: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ }
];

const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

function git(args, cwd, encoding = 'utf8') {
  const result = spawnSync('git', args, {
    cwd,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'unknown git error').trim();
    throw new Error(detail);
  }
  return result.stdout;
}

export function detectCommitIntent(command) {
  return analyzeCommit(command).found === true;
}

function normalizeRelative(file) {
  return file.split(path.sep).join('/').replace(/^\.\//, '');
}

function isSensitivePath(file) {
  const normalized = normalizeRelative(file);
  const base = path.posix.basename(normalized).toLowerCase();
  const envLike = base === '.env' || base.startsWith('.env.');
  if (envLike && !SAFE_ENV_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(base)) return true;
  if (/\.(?:pem|p12|pfx|key|keystore|jks)$/i.test(base)) return true;
  return /(?:^|\/)(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|ini))?$/i.test(normalized);
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function scanText(file, content) {
  const findings = [];
  for (const rule of SECRET_RULES) {
    const match = rule.pattern.exec(content);
    if (match) findings.push(`${file}:${lineNumberAt(content, match.index)}: potential ${rule.label}`);
  }
  return findings;
}

export function inspectStaged(cwd) {
  const rawNames = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], cwd);
  const files = rawNames.split('\0').filter(Boolean).map(normalizeRelative);
  const findings = [];

  for (const file of files) {
    if (isSensitivePath(file)) {
      findings.push(`${file}: sensitive file type is staged`);
    }

    let blob;
    try {
      blob = git(['show', `:${file}`], cwd, null);
    } catch (error) {
      findings.push(`${file}: staged blob could not be inspected (${error.message})`);
      continue;
    }

    if (!Buffer.isBuffer(blob)) blob = Buffer.from(blob);
    if (blob.length > DEFAULT_MAX_FILE_BYTES) {
      findings.push(`${file}: staged file is ${blob.length} bytes; limit is ${DEFAULT_MAX_FILE_BYTES}`);
      continue;
    }
    if (blob.includes(0)) continue;
    findings.push(...scanText(file, blob.toString('utf8')));
  }

  return { files, findings };
}

export function evaluate(input, cwd = process.cwd()) {
  const command = input?.tool_input?.command;
  const intent = analyzeCommit(command);
  if (intent.ambiguous) {
    return { exitCode: 2, ruleId: 'commit-command-uninspectable', message: 'BLOCKED by commit-guard [commit-command-uninspectable]: the shell command cannot be normalized safely.' };
  }
  if (!intent.found) return { exitCode: 0, message: '' };
  if (intent.unsupportedScope) {
    return { exitCode: 2, ruleId: 'commit-scope-unsupported', message: 'BLOCKED by commit-guard [commit-scope-unsupported]: run the commit from the active worktree so staged blobs can be verified.' };
  }
  if (intent.tokens.some((token) => token.value === '--no-verify' || token.value === '-n')) {
    return { exitCode: 2, ruleId: 'commit-no-verify', message: 'BLOCKED by commit-guard [commit-no-verify]: the command bypasses repository safeguards.' };
  }

  try {
    const result = inspectStaged(input?.cwd || cwd);
    if (result.findings.length === 0) return { exitCode: 0, message: '' };
    const visible = result.findings.slice(0, 20).map((finding) => `- ${finding}`).join('\n');
    const remainder = result.findings.length > 20 ? `\n- …and ${result.findings.length - 20} more` : '';
    return {
      exitCode: 2,
      message: `BLOCKED by commit-guard:\n${visible}${remainder}\nReview the staged content; the hook never rewrites it.`
    };
  } catch (error) {
    return { exitCode: 2, message: `BLOCKED by commit-guard: staged content could not be verified (${error.message}).` };
  }
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error(`hook input exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error(`hook input is not valid JSON: ${error.message}`);
  }
}

async function main() {
  let result;
  try {
    result = evaluate(await readInput());
  } catch (error) {
    result = { exitCode: 2, message: `BLOCKED by commit-guard: ${error.message}.` };
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
