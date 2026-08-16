#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;

const SHELL_EXECUTABLES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const DYNAMIC_SENSITIVE_EXECUTABLES = new Set([
  'rm', 'dd', 'mkfs', 'diskutil', 'chmod', 'chown', 'gh', 'op', 'pass', 'bw', 'bws', 'lpass',
  'keepassxc-cli', 'rbw', 'nordpass', 'security', 'gpg', 'docker', 'podman', 'crontab'
]);

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
    if (character === '\\') { index += 1; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
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
    if (quote === "'") { if (character === "'") quote = null; else token.value += character; continue; }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') { if (++index >= source.length) return { error: 'trailing escape' }; token.value += source[index]; }
      else if (character === '$' || character === '`') {
        const end = expansionEnd(source, index); if (end < 0) return { error: 'unterminated expansion' };
        token.value += source.slice(index, end); token.dynamic = true; index = end - 1;
      } else token.value += character;
      continue;
    }
    if (/\s/.test(character)) { pushToken(); if (character === '\n') pushCommand(); }
    else if (character === "'" || character === '"') { begin(); quote = character; }
    else if (character === '\\') { begin(); if (++index >= source.length) return { error: 'trailing escape' }; token.value += source[index]; }
    else if (character === '$' || character === '`') {
      begin(); const end = expansionEnd(source, index); if (end < 0) return { error: 'unterminated expansion' };
      token.value += source.slice(index, end); token.dynamic = true; index = end - 1;
    } else if (';&|()'.includes(character)) { pushCommand(); if ((character === '&' || character === '|') && source[index + 1] === character) index += 1; }
    else { begin(); token.value += character; if (character === '{' || character === '}') token.dynamic = true; }
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
    if (SHELL_EXECUTABLES.has(name) || name === 'eval') {
      let payload = name === 'eval' ? index + 1 : -1;
      if (name !== 'eval') {
        for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
          if (tokens[cursor].dynamic) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
          if (tokens[cursor].value === '-c' || tokens[cursor].value === '--command' || /^-[^-]*c[^-]*$/.test(tokens[cursor].value)) { payload = cursor + 1; break; }
          if (!tokens[cursor].value.startsWith('-')) break;
        }
        if (payload < 0) return [{ tokens: tokens.slice(index), wrappers }];
      }
      if (!tokens[payload] || depth >= 3) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
      const inner = name === 'eval' ? tokens.slice(payload).map((entry) => entry.value).join(' ') : tokens[payload].value;
      const nested = normalizeShellCommands(inner, depth + 1);
      return nested.error ? [{ ambiguous: true, wrappers: [...wrappers, name] }] : nested.commands;
    }
    if (!['exec', 'time', 'noglob', 'command', 'env', 'sudo', 'nohup'].includes(name)) return [{ tokens: tokens.slice(index), wrappers }];
    wrappers.push(name);
    index += 1;
    if (name === 'command' && ['-v', '-V'].includes(tokens[index]?.value)) return [{ tokens: tokens.slice(index - 1), wrappers: wrappers.slice(0, -1) }];
    while (index < tokens.length) {
      const option = tokens[index];
      if (option.dynamic) return [{ ambiguous: true, wrappers }];
      if (option.value === '--') { index += 1; break; }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(option.value)) {
        if (/^(?:PATH|SHELL|GIT_DIR|GIT_WORK_TREE|GIT_CONFIG[^=]*)=/.test(option.value)) return [{ ambiguous: true, wrappers }];
        index += 1; continue;
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

const COMMAND_START = String.raw`(?:^|[;&|(\n]\s*)`;

export const RULES = [
  {
    id: 'broad-filesystem-delete',
    reason: 'recursive deletion targets a system, home, or all-users root',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:sudo\s+)?rm\s+(?:(?:-[A-Za-z]+|--[a-z-]+)\s+)*(?:--\s+)?["']?(?:\/\*?|~\/?(?:\*?)|\$HOME\/?(?:\*?)|\$\{HOME\}\/?(?:\*?)|\/Users\/?(?:\*?))["']?(?=\s*(?:$|[;&|]))`, 'm')
  },
  {
    id: 'sudo-rm',
    reason: 'rm is being given administrator authority',
    pattern: new RegExp(String.raw`${COMMAND_START}sudo\s+(?:-[A-Za-z]+\s+)*rm(?:\s|$)`, 'm')
  },
  {
    id: 'raw-disk-write',
    reason: 'the command writes to or formats a raw disk device',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:sudo\s+)?(?:dd\s+[^;&|\n]*\bof=["']?\/dev\/(?:r?disk|sd[a-z]|nvme)|mkfs(?:\.[A-Za-z0-9]+)?(?:\s|$)|diskutil\s+(?:erase\w*|partitionDisk|zeroDisk|secureErase|apfs\s+(?:delete|erase)\w*))`, 'mi')
  },
  {
    id: 'raw-device-redirection',
    reason: 'output redirection targets a raw disk device',
    pattern: />\s*\/dev\/(?:r?disk\d*|sd[a-z]\d*|nvme\w*)/m
  },
  {
    id: 'fork-bomb',
    reason: 'the command contains a shell fork bomb',
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/m
  },
  {
    id: 'internet-to-shell',
    reason: 'remote content is piped directly into a shell',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:curl|wget)\s+[^;&|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh(?:\s|$)`, 'm')
  },
  {
    id: 'forced-remote-history',
    reason: 'git push would rewrite remote history without force-with-lease',
    pattern: new RegExp(String.raw`${COMMAND_START}git\s+push(?:(?!--force-with-lease)[^;&|\n])*?(?:\s-f(?:\s|$)|\s--force(?:=\S+)?(?:\s|$)|\s\+[A-Za-z0-9._/-]+)`, 'm')
  },
  {
    id: 'remote-ref-delete',
    reason: 'git push would delete a remote branch or tag',
    pattern: new RegExp(String.raw`${COMMAND_START}git\s+push[^;&|\n]*(?:\s(?:--delete|-d)(?:\s|$)|\s:[A-Za-z0-9._/-]+)`, 'm')
  },
  {
    id: 'system-permission-destruction',
    reason: 'recursive ownership or world-writable permissions target the system root',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:chmod\s+[^;&|\n]*\b777\s+["']?\/["']?(?=\s*(?:$|[;&|]))|chown\s+-R[^;&|\n]*\s+["']?\/["']?(?=\s*(?:$|[;&|])))`, 'm')
  },
  {
    id: 'recovery-history-destruction',
    reason: 'Git recovery history would be made immediately unrecoverable',
    pattern: new RegExp(String.raw`${COMMAND_START}git\s+(?:reflog\s+expire[^;&|\n]*--expire(?:-unreachable)?(?:=|\s+)now|gc[^;&|\n]*--prune(?:=|\s+)(?:now|all))`, 'm')
  },
  {
    id: 'destructive-github-operation',
    reason: 'the GitHub command performs an irreversible or account-sensitive action',
    pattern: new RegExp(String.raw`${COMMAND_START}gh\s+(?:repo\s+delete(?:\s|$)|release\s+delete(?:\s|$)|(?:secret|ssh-key|gpg-key)\s+delete(?:\s|$)|api\s+[^;&|\n]*(?:-X|--method)(?:=|\s+)(?:DELETE|delete)|repo\s+edit[^;&|\n]*--visibility(?:=|\s+)public|auth\s+token(?:\s|$))`, 'm')
  },
  {
    id: 'credential-store-access',
    reason: 'the command reads or exports secrets from a password manager, keychain, or secret key store',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:bw|bws|lpass|keepassxc-cli|rbw|nordpass)(?:\s|$)|pass\s+(?!--(?:help|version)(?:\s|$))\S+|op\s+(?:read|run|inject|item|document|vault|connect|service-account|events-api|signin)(?:\s|$)|security\s+(?:(?:-[A-Za-z]+|--[a-z-]+)\s+)*(?:find-generic-password|find-internet-password|dump-keychain)(?:\s|$)|gpg\s+[^;&|\n]*--export-secret-(?:keys?|subkeys)(?:\s|=|$)|[^;&|\n]*(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s"']+)\/\.password-store(?:\/|\s|$))`, 'm')
  },
  {
    id: 'local-worktree-destruction',
    reason: 'the Git command explicitly discards uncommitted, untracked, or stashed work',
    pattern: /$a/
  },
  {
    id: 'container-volume-destruction',
    reason: 'the container command deletes persistent volume data',
    pattern: /$a/
  },
  {
    id: 'scheduler-destruction',
    reason: 'the command removes the current user cron table',
    pattern: /$a/
  }
];

function optionPresent(args, longName, shortName) {
  return args.some((token) => {
    if (token.dynamic) return false;
    const value = token.value;
    const folded = value.toLowerCase();
    if (folded === longName || folded.startsWith(`${longName}=`)) return true;
    return shortName && /^-[^-]+$/.test(value) && value.slice(1).includes(shortName);
  });
}

function gitInvocation(tokens) {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.dynamic) return { ambiguous: true };
    const value = token.value;
    if (value === '--') { index += 1; break; }
    if (!value.startsWith('-')) break;
    const consumesNext = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'].includes(value);
    if (consumesNext && (!tokens[index + 1] || tokens[index + 1].dynamic)) return { ambiguous: true };
    index += consumesNext ? 2 : 1;
  }
  const subcommand = tokens[index];
  if (!subcommand || subcommand.dynamic) return { ambiguous: Boolean(subcommand?.dynamic) };
  return { name: subcommand.value.toLowerCase(), args: tokens.slice(index + 1) };
}

function deterministicCommandRule(entry) {
  if (!entry.tokens?.length) return null;
  const executable = executableName(entry.tokens[0]);
  if (executable === 'git') {
    const invocation = gitInvocation(entry.tokens);
    if (invocation.ambiguous) return 'shell-command-uninspectable';
    const { name, args = [] } = invocation;
    if (args.some((token) => token.dynamic) && ['reset', 'clean', 'checkout', 'restore', 'stash'].includes(name)) {
      return 'shell-command-uninspectable';
    }
    if (name === 'reset' && optionPresent(args, '--hard', null)) return 'local-worktree-destruction';
    if (name === 'clean'
      && optionPresent(args, '--force', 'f')
      && !optionPresent(args, '--dry-run', 'n')) return 'local-worktree-destruction';
    if (name === 'checkout') {
      const separator = args.findIndex((token) => token.value === '--');
      if ((separator >= 0 && separator < args.length - 1)
        || args.some((token) => ['.', ':/'].includes(token.value))) return 'local-worktree-destruction';
    }
    if (name === 'restore'
      && (!optionPresent(args, '--staged', 'S') || optionPresent(args, '--worktree', 'W'))) {
      return 'local-worktree-destruction';
    }
    if (name === 'stash' && ['drop', 'clear'].includes(args.find((token) => !token.value.startsWith('-'))?.value)) {
      return 'local-worktree-destruction';
    }
  }
  if (['docker', 'podman'].includes(executable)) {
    if (entry.tokens.slice(1).some((token) => token.dynamic)) return 'shell-command-uninspectable';
    const args = entry.tokens.slice(1).map((token) => token.value.toLowerCase());
    if (args[0] === 'volume' && ['rm', 'remove', 'prune'].includes(args[1])) return 'container-volume-destruction';
    if (args[0] === 'system' && args[1] === 'prune' && args.includes('--volumes')) return 'container-volume-destruction';
  }
  if (executable === 'crontab') {
    if (entry.tokens.slice(1).some((token) => token.dynamic)) return 'shell-command-uninspectable';
    if (optionPresent(entry.tokens.slice(1), '--remove', 'r')) return 'scheduler-destruction';
  }
  return null;
}

export function extractCommand(input) {
  const command = input?.tool_input?.command ?? input?.toolInput?.command ?? input?.command;
  return typeof command === 'string' ? command : '';
}

export function evaluate(input) {
  const command = extractCommand(input);
  if (!command) return { exitCode: 0, message: '', ruleId: null };
  const lexicalRule = RULES.find((rule) => rule.id === 'fork-bomb' && rule.pattern.test(command));
  if (lexicalRule) {
    return {
      exitCode: 2,
      ruleId: lexicalRule.id,
      message: `BLOCKED by shell-command-guard [${lexicalRule.id}]: ${lexicalRule.reason}. Do not retry or work around this guard; explain the blocked action to the user.`
    };
  }
  const normalized = normalizeShellCommands(command);
  if (normalized.error || normalized.commands.some((entry) => entry.ambiguous)) {
    return {
      exitCode: 2,
      ruleId: 'shell-command-uninspectable',
      message: 'BLOCKED by shell-command-guard [shell-command-uninspectable]: the command cannot be normalized safely. Expand dynamic command construction before retrying.'
    };
  }
  const candidates = [command, ...normalized.commands.map((entry) => entry.tokens?.map((token) => token.value).join(' ') || '')];
  let matchedRule = RULES.find((rule) => candidates.some((candidate) => rule.pattern.test(candidate)));
  if (!matchedRule) {
    const sudoRm = normalized.commands.some((entry) => entry.tokens?.length
      && entry.wrappers?.includes('sudo') && executableName(entry.tokens[0]) === 'rm');
    if (sudoRm) matchedRule = RULES.find((rule) => rule.id === 'sudo-rm');
  }
  if (!matchedRule) {
    const internetToShell = normalized.commands.some((entry, index) => {
      const next = normalized.commands[index + 1];
      return entry.tokens?.length && next?.tokens?.length
        && ['curl', 'wget'].includes(executableName(entry.tokens[0]))
        && SHELL_EXECUTABLES.has(executableName(next.tokens[0]));
    });
    if (internetToShell) matchedRule = RULES.find((rule) => rule.id === 'internet-to-shell');
  }
  if (!matchedRule) {
    const deterministicRule = normalized.commands.map(deterministicCommandRule).find(Boolean);
    if (deterministicRule === 'shell-command-uninspectable') {
      return {
        exitCode: 2,
        ruleId: deterministicRule,
        message: 'BLOCKED by shell-command-guard [shell-command-uninspectable]: a protected command uses arguments that cannot be inspected safely.'
      };
    }
    if (deterministicRule) matchedRule = RULES.find((rule) => rule.id === deterministicRule);
  }
  if (!matchedRule) {
    const dynamicSensitive = normalized.commands.some((entry) => {
      if (!entry.tokens?.length || !entry.tokens.slice(1).some((token) => token.dynamic)) return false;
      const executable = executableName(entry.tokens[0]);
      if (DYNAMIC_SENSITIVE_EXECUTABLES.has(executable)) return true;
      if (executable === 'git') {
        const subcommand = entry.tokens.slice(1).find((token) => !token.value.startsWith('-'));
        return subcommand?.dynamic || ['push', 'reflog', 'gc'].includes(subcommand?.value);
      }
      return false;
    });
    if (dynamicSensitive) {
      return {
        exitCode: 2,
        ruleId: 'shell-command-uninspectable',
        message: 'BLOCKED by shell-command-guard [shell-command-uninspectable]: a protected command uses dynamic arguments that can hide destructive options.'
      };
    }
  }
  if (matchedRule) {
    return {
      exitCode: 2,
      ruleId: matchedRule.id,
      message: `BLOCKED by shell-command-guard [${matchedRule.id}]: ${matchedRule.reason}. Do not retry or work around this guard; explain the blocked action to the user.`
    };
  }
  return { exitCode: 0, message: '', ruleId: null };
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
    result = { exitCode: 2, message: `BLOCKED by shell-command-guard: ${error.message}.` };
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
