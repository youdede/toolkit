#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;
const ALLOW = { exitCode: 0 };
const BLOCK = (ruleId, reason) => ({ exitCode: 2, ruleId, message: `BLOCKED by user-account-mutation-guard [${ruleId}]: ${reason}` });

function executableName(value) {
  return String(value || '').replaceAll('\\', '/').split('/').at(-1).toLowerCase();
}

function lexShell(source) {
  const commands = []; let tokens = []; let value = ''; let quote = ''; let escaped = false; let dynamic = false;
  const word = () => { if (value || dynamic) tokens.push({ value, dynamic }); value = ''; dynamic = false; };
  const command = () => { word(); if (tokens.length) commands.push(tokens); tokens = []; };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { value += character; escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = '';
      else { value += character; if (quote === '"' && (character === '$' || character === String.fromCharCode(96))) dynamic = true; }
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '$' || character === String.fromCharCode(96)) { dynamic = true; value += character; continue; }
    if (/\s/.test(character)) { word(); if (character === '\n') command(); continue; }
    if (';&|'.includes(character)) { command(); if (source[index + 1] === character) index += 1; continue; }
    value += character;
  }
  if (quote || escaped) return { error: true, commands: [] };
  command();
  return { commands };
}

function skipOption(tokens, index, takesValue) {
  const token = tokens[index]?.value || '';
  if (!token.startsWith('-') || token === '--') return index;
  if (!token.includes('=') && takesValue.has(token)) return index + 2;
  return index + 1;
}

function unwrap(tokens, depth = 0) {
  let cursor = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor]?.value || '')) cursor += 1;
  for (;;) {
    const executable = executableName(tokens[cursor]?.value);
    if (executable === 'env') {
      cursor += 1;
      while (tokens[cursor] && (tokens[cursor].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor].value))) {
        cursor = /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor].value)
          ? cursor + 1
          : skipOption(tokens, cursor, new Set(['-u', '--unset', '-C', '--chdir']));
      }
      continue;
    }
    if (['command', 'nohup', 'setsid'].includes(executable)) { cursor += 1; while (tokens[cursor]?.value.startsWith('-')) cursor += 1; continue; }
    if (['sudo', 'doas'].includes(executable)) {
      cursor += 1;
      while (tokens[cursor]?.value.startsWith('-')) cursor = skipOption(tokens, cursor, new Set(['-u', '-g', '-h', '-p', '-C', '-T', '--user', '--group', '--host', '--prompt', '--chdir']));
      continue;
    }
    if (executable === 'time' || executable === 'nice') {
      cursor += 1;
      while (tokens[cursor]?.value.startsWith('-')) cursor = skipOption(tokens, cursor, new Set(['-f', '-o', '--format', '--output', '-n', '--adjustment']));
      continue;
    }
    if (executable === 'timeout') {
      cursor += 1;
      while (tokens[cursor]?.value.startsWith('-')) cursor = skipOption(tokens, cursor, new Set(['-k', '--kill-after', '-s', '--signal']));
      if (tokens[cursor]) cursor += 1;
      continue;
    }
    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(executable)) {
      const option = tokens.findIndex((token, index) => index > cursor && (/^-[^-]*c/.test(token.value) || token.value === '--command'));
      if (option < 0 || !tokens[option + 1] || tokens[option + 1].dynamic || depth >= 3) return [{ invalid: true }];
      const nested = normalizeCommands(tokens[option + 1].value, depth + 1);
      return nested.error ? [{ invalid: true }] : nested.entries;
    }
    break;
  }
  if (!tokens[cursor]) return [{ invalid: true }];
  return [{
    executable: executableName(tokens[cursor].value),
    executableDynamic: tokens[cursor].dynamic,
    args: tokens.slice(cursor + 1),
    dynamic: tokens.slice(cursor + 1).some((token) => token.dynamic)
  }];
}

function normalizeCommands(source, depth = 0) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_COMMAND_BYTES) return { error: true, entries: [] };
  const parsed = lexShell(source);
  if (parsed.error) return { error: true, entries: [] };
  return { entries: parsed.commands.flatMap((tokens) => unwrap(tokens, depth)) };
}

function values(entry) {
  return entry.args.map((token) => token.value);
}

function stripLeadingOptions(args, valueOptions = new Set()) {
  let index = 0;
  while (args[index]?.value.startsWith('-') && args[index].value !== '--') index = skipOption(args, index, valueOptions);
  if (args[index]?.value === '--') index += 1;
  return args.slice(index);
}


function policy(entry) {
  const unix = new Set(['useradd', 'adduser', 'userdel', 'deluser', 'usermod', 'groupadd', 'addgroup', 'groupdel', 'delgroup', 'groupmod', 'gpasswd', 'chpasswd', 'passwd']);
  if (unix.has(entry.executable)) return entry.dynamic ? 'account-command-uninspectable' : 'unix-account-mutation';
  const args = values(entry).map((value) => value.toLowerCase());
  if (entry.executable === 'pw' && ['useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'groupmod'].includes(args[0])) return 'unix-account-mutation';
  if (['dscl', 'sysadminctl'].includes(entry.executable) && args.some((value) => ['-create', '-delete', '-passwd', '-append', '-merge', '-adminuser'].includes(value))) return 'macos-account-mutation';
  if (entry.executable === 'net' && ['user', 'localgroup'].includes(args[0]) && args.some((value) => ['/add', '/delete'].includes(value))) return 'windows-account-mutation';
  if (/^(?:new|remove|set)-local(?:user|group)$/.test(entry.executable)) return 'windows-account-mutation';
  return null;
}

export function evaluate(input) {
  if (!input || typeof input !== 'object' || !input.tool_input || typeof input.tool_input !== 'object') return BLOCK('user-account-mutation-input-invalid', 'the hook input is malformed.');
  if (input.tool_name !== 'Bash') return ALLOW;
  const command = input.tool_input.command;
  const normalized = normalizeCommands(command);
  if (normalized.error || normalized.entries.some((entry) => entry.invalid)) return BLOCK('account-command-uninspectable', 'the account command cannot be normalized safely.');
  for (const entry of normalized.entries) {
    const ruleId = policy(entry);
    if (ruleId) return BLOCK(ruleId, 'the account command cannot be normalized safely.');
  }
  return ALLOW;
}

async function readInput() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error('oversized');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = evaluate(await readInput());
    if (result.exitCode) process.stderr.write(`${result.message}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('BLOCKED by user-account-mutation-guard [user-account-mutation-input-invalid]: hook input is invalid or oversized.\n');
    process.exitCode = 2;
  }
}
