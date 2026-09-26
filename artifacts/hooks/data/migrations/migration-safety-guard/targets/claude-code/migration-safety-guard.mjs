#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// <youdede:shared shell>
// Shared shell analysis for Youdede Bash hooks (shared block `shell`). Hooks stay single-file:
// scripts/generate-shared-hooks.mjs copies this file into each hook between the block markers. Edit it
// here and run `npm run shared-hooks`; tests/shared-hook-shell.test.mjs holds the probes every hook shares.
// Nothing is executed. Every loop advances its index or is capped, and nested shells stop at depth 3.

export const SHELL_MAX_COMMAND_BYTES = 256 * 1024;
const SHELL_MAX_DEPTH = 3;
const SHELL_MAX_WRAPPERS = 16;
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHELL_WRAPPERS = new Set(['exec', 'time', 'noglob', 'command', 'env', 'sudo', 'doas', 'setsid', 'nohup', 'nice', 'timeout', 'xargs']);
const SHELL_DIRECTORY_CHANGERS = new Set(['cd', 'pushd', 'popd']);
const SHELL_SENSITIVE_ASSIGNMENT = /^(?:PATH|SHELL|GIT_DIR|GIT_WORK_TREE|GIT_CONFIG[^=]*)=/;
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Reserved words that precede a command, and those that end a compound command or start a header
// (`for x in …`, `case … in`) whose words are not a command. `if true; then rm -rf /; fi` runs rm.
const SHELL_PREFIX_KEYWORDS = new Set(['!', '{', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const SHELL_SKIPPED_KEYWORDS = new Set(['}', 'fi', 'done', 'esac', 'for', 'select', 'case']);
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

// Options of each wrapper: `next` takes the following token as its value, `alone` stands alone or
// carries its value. Anything else is ambiguous, because it could hide the wrapped command.
const WRAPPER_OPTIONS = {
  sudo: {
    next: /^(?:-u|-g|-h|-p|-C|-T|-r|-t)$/,
    alone: /^(?:-[AbEHKnS]+|--(?:askpass|background|preserve-env|edit|set-home|remove-timestamp|reset-timestamp|non-interactive|stdin|validate)|--(?:user|group|host|prompt|close-from|command-timeout|role|type)=.+)$/,
    refuse: /^(?:-D|--chdir|-R|--chroot)(?:=|$)/
  },
  doas: { next: /^-[uC]$/, alone: /^-[Lns]+$/ },
  setsid: { alone: /^(?:-[cfw]+|--(?:ctty|fork|wait))$/ },
  time: { next: /^(?:-f|-o|--format|--output)$/, alone: /^(?:-a|-p|-v|--append|--portability|--verbose|--quiet|--format=.+|--output=.+)$/ },
  exec: { next: /^-a$/, alone: /^(?:-c|-l)$/ },
  command: { alone: /^-p$/ },
  noglob: {},
  nohup: {},
  nice: { next: /^(?:-n|--adjustment)$/, alone: /^(?:-n.+|--adjustment=.+|-[-+]?\d+)$/ },
  timeout: {
    next: /^(?:-s|-k|--signal|--kill-after)$/,
    alone: /^(?:-s.+|-k.+|--signal=.+|--kill-after=.+|-v|--verbose|-f|--foreground|-p|--preserve-status)$/
  },
  xargs: {
    next: /^(?:-[ILnPdEsaJRS]|--(?:arg-file|delimiter|max-lines|max-args|max-procs|max-chars|process-slot-var))$/,
    alone: /^(?:-[0rtpxo]+|-[ILnPdEsaJRS].+|-[ie].*|-l\d*|--(?:null|no-run-if-empty|verbose|interactive|exit|open-tty|show-limits|replace)|--(?:arg-file|delimiter|max-lines|max-args|max-procs|max-chars|process-slot-var|replace|eof)=.*)$/
  }
};

// PowerShell hosts take case-insensitive options and their unambiguous prefixes.
const POWERSHELL_VALUE_OPTIONS = /^-(?:ex|ep|executionpolicy|inp|if|inputformat|o|of|outputformat|w|windowstyle|wd|workingdirectory|config|configurationname|v|version|settings|settingsfile|custompipename)$/;
const POWERSHELL_FLAGS = /^-(?:nop|noprofile|nol|nologo|noni|noninteractive|noe|noexit|sta|mta|l|login|i|interactive)$/;

// A value supplied at run time by xargs or find (`{}`), not by the shell: it is neither static
// nor a shell expansion.
function placeholderToken(value = '') {
  return { value, dynamic: false, placeholder: true };
}

// End index (exclusive) of the expansion starting at `start`: `$name`, `${…}`, `$(…)`, a backtick
// block, or a process substitution `<(…)`/`>(…)`. -1 when unterminated.
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
    const pattern = /\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!_-])/y;
    pattern.lastIndex = start;
    return pattern.test(source) ? pattern.lastIndex : start + 1;
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

// Splits source into segments of tokens. Quotes and escapes are removed; expansions stay as text and
// mark the token dynamic, and an unquoted `*`, `?`, or `[` marks it `glob`. `operator` is the one that
// ends the segment: `&&`, `||`, `;`, `|`, `&`, `\n`, `(`, `)`, or '' at the end. With
// `options.redirections`, redirections leave the tokens and go to `redirections` as { operator, target }:
// `2>&1` is { operator: '2>&', target: '1' }, `x>out` is the token x and { operator: '>', target: 'out' }.
function lexShell(source, options = {}) {
  const segments = [];
  let tokens = [];
  let redirections = [];
  let redirect = null;
  let token = null;
  let quote = null;
  const begin = () => { if (!token) token = { value: '', dynamic: false }; };
  const pushToken = () => {
    if (!token) return;
    // Only `{a,b}` and `{x..y}` expand; `{}` and `stash@{0}` are literal.
    if (token.braces && /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(token.value)) token.dynamic = true;
    delete token.braces;
    delete token.quoted;
    if (redirect) { redirections.push({ operator: redirect, target: token }); redirect = null; } else tokens.push(token);
    token = null;
  };
  const pushSegment = (operator) => {
    pushToken();
    if (redirect) return false;
    if (tokens.length || redirections.length) segments.push(options.redirections ? { tokens, operator, redirections } : { tokens, operator });
    tokens = [];
    redirections = [];
    return true;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") { if (character === "'") quote = null; else token.value += character; continue; }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') { if (++index >= source.length) return { error: 'trailing escape' }; token.value += source[index]; }
      else if (character === '$' || character === '`') {
        const end = expansionEnd(source, index);
        if (end < 0) return { error: 'unterminated expansion' };
        token.value += source.slice(index, end); token.dynamic = true; index = end - 1;
      } else token.value += character;
      continue;
    }
    if (/\s/.test(character)) { pushToken(); if (character === '\n' && !pushSegment('\n')) return { error: 'redirection without target' }; }
    else if (character === "'" || character === '"') { begin(); token.quoted = true; quote = character; }
    else if (character === '\\') { begin(); if (++index >= source.length) return { error: 'trailing escape' }; token.value += source[index]; }
    else if (character === '$' || character === '`' || ((character === '<' || character === '>') && source[index + 1] === '(')) {
      begin();
      const end = expansionEnd(source, index);
      if (end < 0) return { error: 'unterminated expansion' };
      token.value += source.slice(index, end); token.dynamic = true; index = end - 1;
    } else if (options.redirections && (character === '<' || character === '>' || (character === '&' && source[index + 1] === '>'))) {
      // A file descriptor number written right before the operator belongs to it.
      let operator = '';
      if (character !== '&' && token && !token.quoted && !token.dynamic && /^\d+$/.test(token.value)) { operator = token.value; token = null; }
      pushToken();
      if (redirect) return { error: 'redirection without target' };
      if (character === '&') {
        operator += '&>'; index += 1;
        if (source[index + 1] === '>') { operator += '>'; index += 1; }
      } else {
        operator += character;
        const next = source[index + 1];
        if (next === character) {
          operator += next; index += 1;
          if (character === '<' && (source[index + 1] === '<' || source[index + 1] === '-')) { operator += source[index + 1]; index += 1; }
        } else if (next === '&' || next === '|' || (character === '<' && next === '>')) { operator += next; index += 1; }
      }
      redirect = operator;
    } else if (character === '&' && (/[<>]$/.test(token?.value ?? '') || source[index + 1] === '>')) {
      // `2>&1`, `>&2`, `&>file`: a redirection, not a command separator.
      begin(); token.value += character;
    } else if (';&|()'.includes(character)) {
      let operator = character;
      if ((character === '&' || character === '|') && source[index + 1] === character) { operator += character; index += 1; }
      if (!pushSegment(operator)) return { error: 'redirection without target' };
    } else {
      begin();
      token.value += character;
      if (character === '{' || character === '}') token.braces = true;
      if (character === '*' || character === '?' || character === '[') token.glob = true;
    }
  }
  if (quote) return { error: 'unterminated quote' };
  if (!pushSegment('')) return { error: 'redirection without target' };
  return { segments };
}

export function executableName(token) {
  return token.value.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
}

// Commands that find runs through -exec/-execdir/-ok/-okdir, with `{}` as a placeholder.
function findActions(tokens, depth, wrappers, parseOptions) {
  const entries = [];
  let index = 1;
  while (index < tokens.length) {
    if (!FIND_EXEC_ACTIONS.has(tokens[index].value)) { index += 1; continue; }
    const start = index + 1;
    let end = start;
    while (end < tokens.length && tokens[end].value !== ';' && tokens[end].value !== '+') end += 1;
    // Without a terminator find refuses to run, so nothing is executed.
    if (end >= tokens.length) break;
    const inner = tokens.slice(start, end).map((entry) => (entry.value.includes('{}') ? placeholderToken(entry.value) : entry));
    if (inner.length) entries.push(...unwrapCommand(inner, depth, [...wrappers, 'find'], parseOptions));
    index = end + 1;
  }
  return entries;
}

// `pwsh`/`powershell`: -Command (or, for Windows PowerShell, the first word) runs the rest of the line;
// -File, or a first word for pwsh, runs a script. The payload is read with this POSIX lexer, an
// approximation of PowerShell syntax; -EncodedCommand and unknown options are ambiguous.
function powershellCommands(tokens, index, depth, wrappers, name, parseOptions) {
  const layer = [...wrappers, name];
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const option = tokens[cursor];
    if (option.dynamic || option.placeholder) return [{ ambiguous: true, wrappers: layer }];
    const value = option.value.toLowerCase();
    if (POWERSHELL_VALUE_OPTIONS.test(value)) { cursor += 1; continue; }
    if (POWERSHELL_FLAGS.test(value)) continue;
    if (/^-f(?:i(?:le?)?)?$/.test(value) || (name === 'pwsh' && !value.startsWith('-'))) return [{ tokens: tokens.slice(index), wrappers }];
    let payload = cursor;
    if (/^-c(?:o(?:m(?:m(?:a(?:nd?)?)?)?)?)?$/.test(value)) payload = cursor + 1;
    else if (value.startsWith('-')) return [{ ambiguous: true, wrappers: layer }];
    if (payload >= tokens.length || depth >= SHELL_MAX_DEPTH) return [{ ambiguous: true, wrappers: layer }];
    const nested = parseShellCommands(tokens.slice(payload).map((entry) => entry.value).join(' '), depth + 1, layer, parseOptions);
    return nested.error ? [{ ambiguous: true, wrappers: layer }] : nested.commands;
  }
  return [{ tokens: tokens.slice(index), wrappers }];
}

function unwrapCommand(original, depth, inherited = [], parseOptions = {}) {
  let tokens = original;
  let index = 0;
  const wrappers = [...inherited];
  const ambiguous = () => [{ ambiguous: true, wrappers }];
  while (index < tokens.length && !tokens[index].dynamic) {
    // `function name { …`: the body starts after the name.
    if (tokens[index].value === 'function') index += 2;
    else if (SHELL_PREFIX_KEYWORDS.has(tokens[index].value)) index += 1;
    else break;
  }
  if (index >= tokens.length || (!tokens[index].dynamic && SHELL_SKIPPED_KEYWORDS.has(tokens[index].value))) return [];
  while (index < tokens.length && SHELL_ASSIGNMENT.test(tokens[index].value)) {
    if (SHELL_SENSITIVE_ASSIGNMENT.test(tokens[index].value)) return ambiguous();
    index += 1;
  }
  for (let count = 0; count < SHELL_MAX_WRAPPERS && index < tokens.length; count += 1) {
    const executable = tokens[index];
    if (executable.dynamic || executable.placeholder || /[*?]|\[[^\]]*\]/.test(executable.value)) return ambiguous();
    const name = executableName(executable);
    if (/^(?:pwsh|powershell)(?:\.exe)?$/.test(name)) return powershellCommands(tokens, index, depth, wrappers, name.replace(/\.exe$/, ''), parseOptions);
    if (SHELL_NAMES.has(name) || name === 'eval') {
      let payload = name === 'eval' ? index + 1 : -1;
      if (name !== 'eval') {
        for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
          const option = tokens[cursor];
          if (option.dynamic || option.placeholder) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
          if (option.value === '-c' || option.value === '--command' || /^-[^-]*c[^-]*$/.test(option.value)) { payload = cursor + 1; break; }
          // `-o option`, `+O shopt`: the next token is the option name, not a script.
          if (/^[-+][oO]$/.test(option.value)) { cursor += 1; continue; }
          if (!/^[-+]./.test(option.value)) break;
        }
        if (payload < 0) return [{ tokens: tokens.slice(index), wrappers }];
      }
      if (!tokens[payload] || depth >= SHELL_MAX_DEPTH) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
      const inner = name === 'eval' ? tokens.slice(payload).map((entry) => entry.value).join(' ') : tokens[payload].value;
      const nested = parseShellCommands(inner, depth + 1, [...wrappers, name], parseOptions);
      if (nested.error) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
      return nested.commands;
    }
    if (name === 'find') return [{ tokens: tokens.slice(index), wrappers }, ...findActions(tokens.slice(index), depth, wrappers, parseOptions)];
    if (!SHELL_WRAPPERS.has(name)) return [{ tokens: tokens.slice(index), wrappers }];
    wrappers.push(name);
    index += 1;
    if (name === 'command' && ['-v', '-V'].includes(tokens[index]?.value)) return [{ tokens: tokens.slice(index - 1), wrappers: wrappers.slice(0, -1) }];
    const options = WRAPPER_OPTIONS[name] || {};
    let replace = null;
    while (index < tokens.length) {
      const option = tokens[index];
      if (option.dynamic || option.placeholder) return ambiguous();
      const value = option.value;
      if (value === '--') { index += 1; break; }
      if (name === 'env' && SHELL_ASSIGNMENT.test(value)) {
        if (SHELL_SENSITIVE_ASSIGNMENT.test(value)) return ambiguous();
        index += 1;
        continue;
      }
      if (!value.startsWith('-')) break;
      if (name === 'env') {
        if (/^(?:-S|--split-string|-C|--chdir|-a|--argv0)(?:=|$)/.test(value)) return ambiguous();
        if (/^(?:-u|--unset)$/.test(value)) { index += 2; continue; }
        if (/^(?:-u.+|--unset=.+|-i|--ignore-environment|-0|--null|-v|--debug)$/.test(value)) { index += 1; continue; }
        return ambiguous();
      }
      if (options.refuse?.test(value)) return ambiguous();
      if (name === 'xargs') {
        if (value === '-I' || value === '--replace') replace = value === '-I' ? tokens[index + 1]?.value : '{}';
        else if (/^-I.+/.test(value)) replace = value.slice(2);
        else if (/^--replace=/.test(value)) replace = value.slice('--replace='.length) || '{}';
        else if (/^-i/.test(value)) replace = value.slice(2) || '{}';
        if (value === '--replace') { index += 1; continue; }
      }
      if (options.next?.test(value)) {
        if (!tokens[index + 1] || tokens[index + 1].dynamic) return ambiguous();
        index += 2;
        continue;
      }
      if (options.alone?.test(value)) { index += 1; continue; }
      return ambiguous();
    }
    if (name === 'timeout') {
      // The duration comes first; `timeout` without one runs nothing.
      if (!tokens[index] || tokens[index].dynamic) return ambiguous();
      index += 1;
    }
    if (name === 'xargs') {
      // xargs runs `echo` without a command and appends input words, or substitutes them for the
      // replacement string. Either way the extra arguments are unknown here.
      const rest = index < tokens.length ? tokens.slice(index) : [{ value: 'echo', dynamic: false }];
      tokens = replace
        ? rest.map((entry, position) => (position > 0 && entry.value.includes(replace) ? placeholderToken(entry.value) : entry))
        : [...rest, placeholderToken()];
      index = 0;
    }
  }
  if (index < tokens.length && SHELL_WRAPPERS.has(executableName(tokens[index]))) return ambiguous();
  return index < tokens.length ? [{ tokens: tokens.slice(index), wrappers }] : ambiguous();
}

// Returns { commands } where each command is { tokens, wrappers, operator, changedDirectory } or
// { ambiguous: true }, or { error } when the text cannot be lexed. `operator` follows the command, so
// `a && b` runs b only if a succeeded while `a; b` runs b anyway. Wrappers (sudo, doas, setsid, env,
// nice, timeout, xargs, exec, time, noglob, command, nohup) and static `sh -c`/`bash -c`/`eval`/
// `pwsh -Command` layers are removed; `find -exec` adds the command it runs. `changedDirectory` is
// true after cd, pushd, or popd in the same command. With `options.redirections`, each command also
// carries the `redirections` of its segment, and a segment made only of redirections (`> file`)
// yields a command with no tokens. An ambiguous entry carries `segment`, the tokens of the innermost
// segment it came from, so a hook can still judge that segment's text.
export function parseShellCommands(command, depth = 0, wrappers = [], options = {}) {
  if (typeof command !== 'string') return { commands: [] };
  if (Buffer.byteLength(command, 'utf8') > SHELL_MAX_COMMAND_BYTES) return { error: 'command exceeds analysis limit', commands: [] };
  const lexed = lexShell(command, options);
  if (lexed.error) return { error: lexed.error, commands: [] };
  const commands = [];
  for (const segment of lexed.segments) {
    let entries = unwrapCommand(segment.tokens, depth, wrappers, options);
    if (segment.redirections?.length) {
      if (!entries.length) entries = [{ tokens: [], wrappers: [...wrappers] }];
      for (const entry of entries) entry.redirections = [...(entry.redirections ?? []), ...segment.redirections];
    }
    // Nested entries keep their inner operator; the last one, and a find action, take the segment's.
    if (entries.length) entries.at(-1).operator = segment.operator;
    for (const entry of entries) {
      entry.operator ??= segment.operator;
      if (entry.ambiguous) entry.segment ??= segment.tokens;
    }
    commands.push(...entries);
  }
  if (depth === 0) {
    let changed = false;
    for (const entry of commands) {
      entry.changedDirectory = changed;
      if (entry.tokens?.length && SHELL_DIRECTORY_CHANGERS.has(executableName(entry.tokens[0]))) changed = true;
    }
  }
  return { commands };
}

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--attr-source', '--list-cmds']);

// Parses `git [global options] <subcommand> [args]` from the tokens of one command. `scoped` is true
// when -C, --git-dir, or --work-tree points Git at another repository or directory; `config` lists
// the -c and --config-env settings. Dynamic global options are ambiguous.
export function gitInvocation(tokens) {
  const globals = { directories: [], gitDir: null, workTree: null, config: [] };
  const record = (option, value) => {
    if (option === '-C') globals.directories.push(value);
    else if (option === '--git-dir') globals.gitDir = value;
    else if (option === '--work-tree') globals.workTree = value;
    else if (option === '-c') {
      const separator = value.indexOf('=');
      globals.config.push(separator < 0 ? { key: value.toLowerCase(), value: 'true' } : { key: value.slice(0, separator).toLowerCase(), value: value.slice(separator + 1) });
    } else if (option === '--config-env') {
      const separator = value.indexOf('=');
      globals.config.push({ key: (separator < 0 ? value : value.slice(0, separator)).toLowerCase(), value: null });
    }
  };
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.dynamic || token.placeholder) return { ambiguous: true };
    const value = token.value;
    if (value === '--') { index += 1; break; }
    if (!value.startsWith('-')) break;
    if (GIT_VALUE_OPTIONS.has(value)) {
      const next = tokens[index + 1];
      if (!next || next.dynamic || next.placeholder) return { ambiguous: true };
      record(value, next.value);
      index += 2;
      continue;
    }
    const equals = value.indexOf('=');
    if (value.startsWith('--') && equals > 0) record(value.slice(0, equals), value.slice(equals + 1));
    index += 1;
  }
  const subcommand = tokens[index];
  const scoped = globals.directories.length > 0 || globals.gitDir !== null || globals.workTree !== null;
  if (!subcommand) return { globals, scoped, args: [] };
  if (subcommand.dynamic || subcommand.placeholder) return { ambiguous: true };
  return { name: subcommand.value.toLowerCase(), index, args: tokens.slice(index + 1), globals, scoped };
}
// </youdede:shared>

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_SQL_BYTES = 512 * 1024;
export const MAX_COMMAND_BYTES = SHELL_MAX_COMMAND_BYTES;

const MIGRATION_EXECUTABLES = new Set(['dropdb', 'prisma', 'rails', 'rake', 'php', 'python', 'django-admin', 'typeorm', 'sequelize', 'npx', 'bunx', 'pnpm', 'yarn']);
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'bun', 'npm']);

// `npx --yes prisma …`, `pnpm prisma …`, `yarn dlx prisma …`, `bun run prisma …`: the package runner,
// its options, and exec/dlx/x/run are dropped so the tool it runs is matched as a command.
// ponytail: a runner option that takes a separate value (`npx -p pkg prisma`) is not skipped.
function withoutPackageRunner(tokens) {
  let rest = tokens;
  while (rest.length && PACKAGE_RUNNERS.has(executableName(rest[0]))) {
    let index = 1;
    while (index < rest.length && (rest[index].value.startsWith('-') || ['exec', 'dlx', 'x', 'run'].includes(rest[index].value))) index += 1;
    rest = rest.slice(index);
  }
  return rest;
}

// Shell aliases defined in the same command (`git config alias.x '!dropdb app'`, `git -c
// alias.x='!…'`) run their body through a shell, so the body is checked like a command.
function gitAliasBodies(tokens) {
  const git = gitInvocation(tokens);
  if (git.ambiguous || !git.name) return [];
  const bodies = git.globals.config.filter((setting) => setting.key.startsWith('alias.') && setting.value?.startsWith('!')).map((setting) => setting.value.slice(1));
  if (git.name === 'config') {
    const values = git.args.filter((token) => !token.value.startsWith('-'));
    const key = values.findIndex((token) => /^alias\./i.test(token.value));
    if (key >= 0 && values[key + 1]?.value.startsWith('!')) bodies.push(values[key + 1].value.slice(1));
  }
  return bodies;
}

const COMMAND_START = String.raw`(?:^|[;&|()]\s*)`;

const COMMAND_RULES = [
  {
    id: 'database-drop-command',
    reason: 'a database-drop utility would delete a database',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:sudo|command)\s+)*(?:[^\s;&|()]+\/)?(?:dropdb(?:\s|$)|mysqladmin\s(?:[^;&|\n]*\s)?drop(?:\s|$))`, 'm')
  },
  {
    id: 'orm-database-reset',
    reason: 'an ORM command would reset or force-reset database state',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+)?(?:[^\s;&|()]+\/)?prisma\s+(?:migrate\s+reset(?:\s|$)|db\s+push\b[^;&|\n]*--(?:force-reset|accept-data-loss)(?:\s|$))`, 'm')
  },
  {
    id: 'framework-database-reset',
    reason: 'a framework command would drop, reset, purge, or flush database state',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:bundle\s+exec\s+)?(?:(?:[^\s;&|()]+\/)?(?:rails|rake)\s+db:(?:drop|reset|purge|truncate_all|migrate:reset)(?::\w+)*(?:\s|$)|php\s+artisan\s+(?:db:wipe|migrate:fresh|migrate:reset)(?:\s|$)|(?:python\s+[^;&|\n]*manage\.py|django-admin)\s+flush\b)`, 'm')
  },
  {
    id: 'schema-drop-command',
    reason: 'a schema-management command would drop the current schema',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:npx|bunx|pnpm\s+exec|yarn\s+dlx)\s+)?(?:typeorm\s+schema:drop|sequelize\s+db:drop)(?:\s|$)`, 'm')
  }
];

const SQL_RULES = [
  { id: 'sql-drop-database', reason: 'DROP DATABASE is a database-wide destructive statement', pattern: /\bDROP\s+DATABASE\b/i },
  { id: 'sql-drop-schema-cascade', reason: 'DROP SCHEMA CASCADE removes the schema and dependent objects', pattern: /\bDROP\s+SCHEMA\b[^;]{0,256}\bCASCADE\b/i },
  { id: 'sql-drop-table', reason: 'DROP TABLE removes a table and its data', pattern: /\bDROP\s+TABLE\b/i },
  { id: 'sql-truncate', reason: 'TRUNCATE removes table data without row qualification', pattern: /\bTRUNCATE(?:\s+TABLE)?\s+(?!\()/i },
  { id: 'sql-drop-column', reason: 'ALTER TABLE DROP COLUMN removes stored column data', pattern: /\bALTER\s+TABLE\b[^;]{0,512}\bDROP\s+COLUMN\b/i }
];

function normalizeRelative(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function proposedText(input, context) {
  const toolInput = input?.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return { text: '' };
  if (typeof toolInput.content === 'string') return { text: toolInput.content };
  if (typeof toolInput.new_string !== 'string') return { text: '' };
  if (typeof toolInput.old_string !== 'string') return { text: toolInput.new_string };
  if (context.inspectionError) return { error: context.inspectionError };
  if (typeof context.existingContent !== 'string') return { error: 'existing migration content is unavailable' };
  const first = context.existingContent.indexOf(toolInput.old_string);
  const second = first < 0 ? -1 : context.existingContent.indexOf(toolInput.old_string, first + Math.max(toolInput.old_string.length, 1));
  if (first < 0) return { error: 'old_string does not match the existing migration' };
  if (second >= 0 || toolInput.old_string.length === 0) return { error: 'old_string is not a unique migration edit boundary' };
  return {
    text: `${context.existingContent.slice(0, first)}${toolInput.new_string}${context.existingContent.slice(first + toolInput.old_string.length)}`
  };
}

function isMigrationSqlPath(relative) {
  if (!relative.toLowerCase().endsWith('.sql')) return false;
  return relative.toLowerCase().split('/').some((segment) => segment === 'migration' || segment === 'migrations');
}

export function maskSqlCommentsAndStrings(sql) {
  let output = '';
  let state = 'code';
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (state === 'code' && current === '-' && next === '-') {
      output += '  ';
      index += 1;
      state = 'line-comment';
    } else if (state === 'code' && current === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
    } else if (state === 'code' && current === "'") {
      output += ' ';
      state = 'string';
    } else if (state === 'line-comment' && current === '\n') {
      output += '\n';
      state = 'code';
    } else if (state === 'block-comment' && current === '*' && next === '/') {
      output += '  ';
      index += 1;
      state = 'code';
    } else if (state === 'string' && current === "'" && next === "'") {
      output += '  ';
      index += 1;
    } else if (state === 'string' && current === "'") {
      output += ' ';
      state = 'code';
    } else {
      output += state === 'code' ? current : (current === '\n' ? '\n' : ' ');
    }
  }
  return output;
}

function findSqlRule(sql) {
  const masked = maskSqlCommentsAndStrings(sql);
  for (const rule of SQL_RULES) if (rule.pattern.test(masked)) return rule;
  for (const statement of masked.split(';')) {
    if (/\bDELETE\s+FROM\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) {
      return { id: 'sql-unqualified-delete', reason: 'DELETE FROM has no visible WHERE clause in the same static statement' };
    }
  }
  return null;
}

// The project root is CLAUDE_PROJECT_DIR, which stays at the project root when Claude runs `cd`;
// the payload cwd follows it. A migration outside that root is still a migration: its path is kept
// absolute so the migration-directory test and the edit reconstruction still apply.
export function collectContext(input, cwd = process.cwd()) {
  const projectRoot = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
  const rawPath = input?.tool_input?.file_path || input?.tool_input?.file;
  let relative = null;
  let absolute = null;
  if (typeof rawPath === 'string' && rawPath) {
    absolute = path.resolve(projectRoot, rawPath);
    const candidate = normalizeRelative(path.relative(projectRoot, absolute));
    relative = candidate !== '..' && !candidate.startsWith('../') && !path.isAbsolute(candidate) ? candidate : normalizeRelative(absolute);
  }
  if (!relative || !isMigrationSqlPath(relative) || typeof input?.tool_input?.old_string !== 'string') {
    return { relative };
  }
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('migration edit target must be a regular file');
    if (stat.size > MAX_SQL_BYTES) throw new Error(`existing migration exceeds ${MAX_SQL_BYTES} bytes`);
    return { relative, existingContent: readFileSync(absolute, 'utf8') };
  } catch (error) {
    return { relative, inspectionError: error.message };
  }
}

export function evaluate(input, context = {}) {
  const command = input?.tool_input?.command;
  if (typeof command === 'string') {
    const normalized = parseShellCommands(command);
    if (normalized.error || normalized.commands.some((entry) => entry.ambiguous)) {
      return { exitCode: 2, ruleId: 'migration-command-uninspectable', message: 'BLOCKED by migration-safety-guard [migration-command-uninspectable]: the shell command cannot be normalized safely.' };
    }
    const protectedDynamic = normalized.commands.some((entry) => entry.tokens?.length
      && MIGRATION_EXECUTABLES.has(executableName(entry.tokens[0]))
      && entry.tokens.slice(1).some((token) => token.dynamic));
    const candidates = normalized.commands.flatMap((entry) => [
      withoutPackageRunner(entry.tokens).map((token) => token.value).join(' '),
      ...gitAliasBodies(entry.tokens)
    ]);
    const rule = candidates
      .flatMap((candidate) => COMMAND_RULES.filter((ruleCandidate) => ruleCandidate.pattern.test(candidate)))
      .at(0);
    if (!rule && protectedDynamic) {
      return { exitCode: 2, ruleId: 'migration-command-uninspectable', message: 'BLOCKED by migration-safety-guard [migration-command-uninspectable]: a migration command uses dynamic control arguments.' };
    }
    if (!rule) return { exitCode: 0, message: '' };
    return {
      exitCode: 2,
      ruleId: rule.id,
      message: `BLOCKED by migration-safety-guard [${rule.id}]: ${rule.reason}. Ask the user to perform any intentional destructive operation outside the guarded agent session.`
    };
  }

  if (!context.relative) return { exitCode: 0, message: '' };
  if (!isMigrationSqlPath(context.relative)) return { exitCode: 0, message: '' };
  const proposed = proposedText(input, context);
  if (proposed.error) {
    return {
      exitCode: 2,
      ruleId: 'migration-edit-inspection-incomplete',
      message: `BLOCKED by migration-safety-guard [migration-edit-inspection-incomplete]: the final migration cannot be reconstructed safely (${proposed.error}).`
    };
  }
  if (!proposed.text || proposed.text.length > MAX_SQL_BYTES) {
    if (proposed.text.length > MAX_SQL_BYTES) {
      return { exitCode: 2, ruleId: 'migration-input-too-large', message: `BLOCKED by migration-safety-guard [migration-input-too-large]: proposed migration text exceeds ${MAX_SQL_BYTES} bytes.` };
    }
    return { exitCode: 0, message: '' };
  }
  const rule = findSqlRule(proposed.text);
  if (!rule) return { exitCode: 0, message: '' };
  return {
    exitCode: 2,
    ruleId: rule.id,
    message: `BLOCKED by migration-safety-guard [${rule.id}]: ${rule.reason}. Ask the user to perform any intentional destructive operation outside the guarded agent session.`
  };
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
    const input = await readInput();
    result = evaluate(input, collectContext(input));
  } catch (error) {
    result = { exitCode: 2, message: `BLOCKED by migration-safety-guard [migration-input-invalid]: ${error.message}.` };
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
