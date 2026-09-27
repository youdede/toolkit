#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
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
const SHELL_WRAPPERS = new Set([
  'exec', 'time', 'noglob', 'command', 'builtin', 'env', 'sudo', 'doas', 'setsid', 'nohup', 'nice', 'timeout', 'xargs',
  'stdbuf', 'ionice', 'chrt', 'taskset', 'flock', 'caffeinate', 'unbuffer', 'chronic'
]);
// Wrappers whose first word after the options is not the command: a duration, priority, CPU mask, or lock file.
const WRAPPER_POSITIONAL = new Set(['timeout', 'chrt', 'taskset', 'flock']);
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
  // `doas -C` only checks the configuration, `-s` and `-L` run no given command.
  doas: { next: /^-u$/, alone: /^-n$/, refuse: /^-[CsL]/ },
  setsid: { alone: /^(?:-[cfw]+|--(?:ctty|fork|wait))$/ },
  time: { next: /^(?:-f|-o|--format|--output)$/, alone: /^(?:-a|-p|-v|--append|--portability|--verbose|--quiet|--format=.+|--output=.+)$/ },
  exec: { next: /^-a$/, alone: /^(?:-c|-l)$/ },
  command: { alone: /^-p$/ },
  builtin: {},
  noglob: {},
  nohup: {},
  unbuffer: {},
  chronic: { alone: /^-[ev]+$/ },
  stdbuf: { next: /^-[ioe]$/, alone: /^(?:-[ioe].+|--(?:input|output|error)=.+)$/ },
  ionice: { next: /^(?:-c|-n|--class|--classdata)$/, alone: /^(?:-c.+|-n.+|-t|--ignore|--(?:class|classdata)=.+)$/ },
  // `chrt -p` and `taskset -p` change a running process; flock -c takes a shell string.
  chrt: { next: /^(?:-T|-P|-D|--sched-runtime|--sched-period|--sched-deadline)$/, alone: /^(?:-[bfiordaRmv]+|--(?:batch|fifo|idle|other|rr|deadline|all-tasks|reset-on-fork|verbose))$/ },
  taskset: { alone: /^(?:-[ac]+|--(?:all-tasks|cpu-list))$/ },
  flock: { next: /^(?:-w|-E|--timeout|--wait|--conflict-exit-code)$/, alone: /^(?:-[sxenuoF]+|-[wE].+|--(?:shared|exclusive|nonblock|nb|unlock|close|no-fork|verbose)|--(?:timeout|wait|conflict-exit-code)=.+)$/ },
  caffeinate: { next: /^-[tw]$/, alone: /^-[dimsu]+$/ },
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
  // A here-document inside a command substitution: its body is data, so quotes in it do not count.
  const heredocs = open === '(' && source[start + 2] !== '(' ? [] : null;
  let depth = 1;
  let quote = null;
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') { index += 1; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (heredocs && isHeredocStart(source, index)) {
      const heredoc = readHeredoc(source, index);
      if (!heredoc) return -1;
      heredocs.push(heredoc);
      index = heredoc.end - 1;
    } else if (heredocs?.length && character === '\n') {
      index = skipHeredocBodies(source, index + 1, heredocs.splice(0)) - 1;
    } else if (character === open) depth += 1;
    else if (character === close && --depth === 0) return index + 1;
  }
  return -1;
}

// `<<` or `<<-` (not the here-string `<<<`) at `index`.
function isHeredocStart(source, index) {
  return source[index] === '<' && source[index + 1] === '<' && source[index + 2] !== '<';
}

// Operator and delimiter word of the here-document starting at `index`, or null without a word.
// A quoted or escaped delimiter keeps the body literal; otherwise the body is expanded.
function readHeredoc(source, index) {
  let cursor = index + 2;
  const stripTabs = source[cursor] === '-';
  if (stripTabs) cursor += 1;
  while (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1;
  let delimiter = '';
  let quoted = false;
  let quote = null;
  for (; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote) { if (character === quote) quote = null; else delimiter += character; continue; }
    if (character === "'" || character === '"') { quote = character; quoted = true; continue; }
    if (character === '\\') { quoted = true; cursor += 1; delimiter += source[cursor] ?? ''; continue; }
    if (/\s/.test(character) || ';&|()<>'.includes(character)) break;
    delimiter += character;
  }
  if (quote || !delimiter) return null;
  return { operator: stripTabs ? '<<-' : '<<', delimiter, quoted, stripTabs, end: cursor, body: '' };
}

// Skips the bodies of `heredocs`, in order, from the line starting at `position`; each body is stored
// on its entry. Returns the index after the last delimiter line, or the end of the source: like
// bash, a body without its delimiter line runs to the end.
function skipHeredocBodies(source, position, heredocs) {
  for (const heredoc of heredocs) {
    while (position < source.length) {
      let lineEnd = source.indexOf('\n', position);
      if (lineEnd < 0) lineEnd = source.length;
      const line = source.slice(position, lineEnd);
      position = lineEnd + 1;
      if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
      heredoc.body += `${line}\n`;
    }
  }
  return Math.min(position, source.length);
}

// Adds to `found` the command text of each substitution the expansion `text` runs: `$(…)`, a backtick
// block, `<(…)`/`>(…)`, and those nested in `${…}` or `$((…))`. Returns false when one is unterminated.
function collectSubstitutions(text, found) {
  if (text.startsWith('`')) { found.push(text.slice(1, -1).replace(/\\([\\`$])/g, '$1')); return true; }
  if (text.startsWith('$((')) return scanSubstitutions(text.slice(3, -2), found);
  if (/^(?:\$|<|>)\(/.test(text)) { found.push(text.slice(2, -1)); return true; }
  if (text.startsWith('${')) return scanSubstitutions(text.slice(2, -1), found, true);
  return true;
}

// Substitutions in free text such as an expanded here-document body. `<(…)`/`>(…)` run only in the word
// of a `${…}` (`${x:-<(cmd)}`); in a here-document body or `$((…))` they are text or comparisons.
function scanSubstitutions(text, found, processSubstitutions = false) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    const substitution = processSubstitutions && (text[index] === '<' || text[index] === '>') && text[index + 1] === '(';
    if (text[index] !== '$' && text[index] !== '`' && !substitution) continue;
    const end = expansionEnd(text, index);
    if (end < 0) return false;
    if (!collectSubstitutions(text.slice(index, end), found)) return false;
    index = end - 1;
  }
  return true;
}

// Splits source into segments of tokens. Quotes and escapes are removed, and a backslash-newline is
// dropped as bash does; expansions stay as text and mark the token dynamic, and an unquoted `*`, `?`, or
// `[` marks it `glob`. Each segment lists in `substitutions` the command text of the `$(…)`, backtick,
// and `<(…)`/`>(…)` substitutions it runs. A here-document body is data: it is skipped, and only the
// substitutions of an unquoted-delimiter body are listed. `operator` is the one that
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
  let substitutions = [];
  let heredocs = [];
  const begin = () => { if (!token) token = { value: '', dynamic: false }; };
  const expansion = (index) => {
    const end = expansionEnd(source, index);
    if (end < 0 || !collectSubstitutions(source.slice(index, end), substitutions)) return -1;
    token.value += source.slice(index, end); token.dynamic = true;
    return end;
  };
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
    if (tokens.length || redirections.length) segments.push(options.redirections ? { tokens, operator, redirections, substitutions } : { tokens, operator, substitutions });
    tokens = [];
    redirections = [];
    substitutions = [];
    return true;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") { if (character === "'") quote = null; else token.value += character; continue; }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') {
        if (++index >= source.length) return { error: 'trailing escape' };
        if (source[index] !== '\n') token.value += source[index];
      } else if (character === '$' || character === '`') {
        const end = expansion(index);
        if (end < 0) return { error: 'unterminated expansion' };
        index = end - 1;
      } else token.value += character;
      continue;
    }
    if (character === '\\' && source[index + 1] === '\n') { index += 1; continue; }
    if (/\s/.test(character)) {
      pushToken();
      if (character !== '\n') continue;
      if (!pushSegment('\n')) return { error: 'redirection without target' };
      if (heredocs.length) {
        const pending = heredocs.splice(0);
        index = skipHeredocBodies(source, index + 1, pending) - 1;
        for (const heredoc of pending) {
          if (!heredoc.quoted && !scanSubstitutions(heredoc.body, heredoc.owner)) return { error: 'unterminated expansion' };
        }
      }
    } else if (character === "'" || character === '"') { begin(); token.quoted = true; quote = character; }
    else if (character === '\\') { begin(); if (++index >= source.length) return { error: 'trailing escape' }; token.value += source[index]; }
    else if (character === '$' || character === '`' || ((character === '<' || character === '>') && source[index + 1] === '(')) {
      begin();
      const end = expansion(index);
      if (end < 0) return { error: 'unterminated expansion' };
      index = end - 1;
    } else if (isHeredocStart(source, index)) {
      const heredoc = readHeredoc(source, index);
      if (!heredoc) return { error: 'redirection without target' };
      let operator = heredoc.operator;
      if (options.redirections && token && !token.quoted && !token.dynamic && /^\d+$/.test(token.value)) { operator = token.value + operator; token = null; }
      pushToken();
      if (redirect) return { error: 'redirection without target' };
      if (options.redirections) redirections.push({ operator, target: { value: heredoc.delimiter, dynamic: false } });
      else tokens.push({ value: operator + heredoc.delimiter, dynamic: false });
      // The body of an unquoted delimiter is attached to this segment when it is read.
      heredoc.owner = substitutions;
      heredocs.push(heredoc);
      index = heredoc.end - 1;
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
  // Only assignments: nothing runs here. Their substitutions are listed with the segment.
  if (index >= tokens.length) return [];
  for (let count = 0; count < SHELL_MAX_WRAPPERS && index < tokens.length; count += 1) {
    const executable = tokens[index];
    if (executable.dynamic || executable.placeholder || /[*?]|\[[^\]]*\]/.test(executable.value)) return ambiguous();
    const name = executableName(executable);
    if (/^(?:pwsh|powershell)(?:\.exe)?$/.test(name)) return powershellCommands(tokens, index, depth, wrappers, name.replace(/\.exe$/, ''), parseOptions);
    if (SHELL_NAMES.has(name) || name === 'eval') {
      let payload = name === 'eval' ? index + 1 : -1;
      if (name !== 'eval') {
        // With -c the command string is the first operand, after every option and `--`. Without it the
        // shell runs its standard input (`… | sh`, `sh -s`, `bash < file`), whose text the command itself
        // supplies and the hook cannot see, or a script file, which is judged like any other program
        // (`./script.sh` and `make` are not read either).
        let command = false;
        let stdin = false;
        let cursor = index + 1;
        for (; cursor < tokens.length; cursor += 1) {
          const option = tokens[cursor];
          if (option.dynamic || option.placeholder) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
          if (option.value === '-') { stdin = true; cursor += 1; break; }
          if (option.value === '--') { cursor += 1; break; }
          if (/^-[^-]*[si]/.test(option.value)) stdin = true;
          // `-o option`, `+O shopt`, `--rcfile file`: the next token is a value, not a script.
          if (/^(?:[-+][oO]|--(?:rcfile|init-file))$/.test(option.value)) { cursor += 1; continue; }
          if (option.value === '--command' || /^-[^-]*c/.test(option.value)) command = true;
          else if (!/^[-+]./.test(option.value)) break;
        }
        if (!command && (stdin || !tokens[cursor])) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
        if (!command) return [{ tokens: tokens.slice(index), wrappers }];
        payload = cursor;
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
    if (WRAPPER_POSITIONAL.has(name)) {
      // The duration, priority, mask, or lock file comes first; without it nothing runs.
      if (!tokens[index] || tokens[index].dynamic) return ambiguous();
      index += 1;
      if (name === 'flock' && /^(?:-c|--command)$/.test(tokens[index]?.value ?? '')) {
        if (!tokens[index + 1] || depth >= SHELL_MAX_DEPTH) return ambiguous();
        const nested = parseShellCommands(tokens[index + 1].value, depth + 1, wrappers, parseOptions);
        return nested.error ? ambiguous() : nested.commands;
      }
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
// nice, timeout, xargs, exec, time, noglob, command, builtin, nohup, stdbuf, ionice, chrt, taskset,
// flock, caffeinate, unbuffer, chronic) and static `sh -c`/`bash -c`/`eval`/`pwsh -Command` layers are
// removed; a shell without -c (a script file or standard input) is ambiguous. `find -exec` adds the
// command it runs, and the commands of `$(…)`, backtick, and `<(…)` substitutions come before the
// command of their segment, with the operator `;`. A segment made only of assignments runs no
// command. After `for name in words`, an argument that is exactly `$name` or `${name}` stands for those
// words. `changedDirectory` is
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
  const loops = new Map();
  for (const segment of lexed.segments) {
    const start = segment.tokens.findIndex((token) => token.dynamic || !SHELL_PREFIX_KEYWORDS.has(token.value));
    const [keyword, variable, word] = start < 0 ? [] : segment.tokens.slice(start);
    if (keyword?.value === 'for' && !keyword.dynamic && word?.value === 'in' && /^[A-Za-z_]\w*$/.test(variable?.value ?? '')) {
      loops.set(variable.value, segment.tokens.slice(start + 3));
    }
    if (loops.size) {
      segment.tokens = segment.tokens.flatMap((token, position) => {
        const name = position > start && token.dynamic ? /^\$(?:\{(\w+)\}|(\w+))$/.exec(token.value) : null;
        return name && loops.has(name[1] ?? name[2]) ? loops.get(name[1] ?? name[2]) : [token];
      });
    }
    for (const text of segment.substitutions) {
      const nested = depth >= SHELL_MAX_DEPTH ? { error: 'too deep' } : parseShellCommands(text, depth + 1, wrappers, options);
      const inner = nested.error ? [{ ambiguous: true, wrappers: [...wrappers], segment: segment.tokens }] : nested.commands;
      if (inner.length) inner.at(-1).operator = ';';
      commands.push(...inner);
    }
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

// <youdede:shared commit-content>
// Shared "what will this command commit" analysis for Youdede hooks (shared block `commit-content`).
// scripts/generate-shared-hooks.mjs drops the import below and requires the `shell` block in the same
// hook. Edit it here and run `npm run shared-hooks`.

// Git subcommands that can change what the index holds before a later `git commit` in the same
// command runs. A hook sees the index before any of them execute.
export const COMMIT_STAGING_SUBCOMMANDS = new Set([
  'add', 'stage', 'rm', 'mv', 'apply', 'update-index', 'restore', 'checkout', 'switch', 'reset',
  'read-tree', 'stash', 'merge', 'pull', 'cherry-pick', 'revert', 'am'
]);
// Git ignores an alias named like a built-in command, so only other names are looked up.
const GIT_BUILTINS = new Set(`add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file
check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool
clean clone column commit commit-graph commit-tree config count-objects credential describe diff
diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch
for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help init
instaweb interpret-trailers log ls-files ls-remote ls-tree maintenance merge merge-base merge-file
merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-refs prune pull
push range-diff read-tree rebase reflog refs remote repack replace replay request-pull rerere reset
restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-ref
sparse-checkout stage stash status submodule switch symbolic-ref tag update-index update-ref var
verify-commit verify-pack verify-tag version whatchanged worktree write-tree`.split(/\s+/));
const COMMIT_MAX_ALIAS_DEPTH = 4;
const COMMIT_VALUE_OPTIONS = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '--author',
  '--date', '--fixup', '--squash', '-t', '--template', '--cleanup', '--trailer'
]);
const COMMIT_WORKTREE_OPTION = /^--(?:all|include|only|interactive|patch|pathspec-from-file(?:=.*)?)$/;
const SHORT_WORKTREE_FLAGS = new Set(['a', 'i', 'o', 'p']);
const SHORT_VALUE_NEXT = new Set(['m', 'F', 'C', 'c', 't']);
const SHORT_VALUE_ATTACHED = new Set(['S', 'u']);
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);

// Walks the options of `git commit` args, which Git parses before and after pathspecs; `visit(flag)`
// sees each long option and each short flag and returns true to stop. Words that xargs appends are
// unknown in number, so they count as a pathspec even where an option takes them as its value.
function walkCommitOptions(tokens, visit) {
  let pathspec = false;
  const takesValue = (index) => { if (tokens[index]?.placeholder) pathspec = true; };
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === '--') return { stopped: false, pathspec: pathspec || index + 1 < tokens.length };
    if (COMMIT_VALUE_OPTIONS.has(value)) { takesValue(index + 1); index += 1; continue; }
    if (value.startsWith('--')) {
      if (visit(value)) return { stopped: true, pathspec };
      continue;
    }
    if (/^-[A-Za-z]/.test(value)) {
      for (let cursor = 1; cursor < value.length; cursor += 1) {
        const flag = value[cursor];
        if (visit(`-${flag}`)) return { stopped: true, pathspec };
        if (SHORT_VALUE_ATTACHED.has(flag)) break;
        if (SHORT_VALUE_NEXT.has(flag)) {
          if (cursor === value.length - 1) { takesValue(index + 1); index += 1; }
          break;
        }
      }
      continue;
    }
    pathspec = true;
  }
  return { stopped: false, pathspec };
}

// True when the commit takes content from the working tree rather than only from the index:
// -a/--all, --include, --only, --interactive, --patch, --pathspec-from-file, or a pathspec.
export function commitReadsWorkingTree(tokens) {
  const walked = walkCommitOptions(tokens, (flag) => COMMIT_WORKTREE_OPTION.test(flag) || (flag.length === 2 && SHORT_WORKTREE_FLAGS.has(flag[1])));
  return walked.stopped || walked.pathspec;
}

// True when the commit skips the repository's hooks: -n in any short-option group, or
// --no-verify and its unambiguous abbreviations.
export function commitSkipsHooks(tokens) {
  return walkCommitOptions(tokens, (flag) => flag === '-n' || /^--no-v(?:e(?:r(?:i(?:fy?)?)?)?)?$/.test(flag)).stopped;
}

// `git add -f` / `git stage --force`: the ignored paths it names, or `all` when they are unknown.
function forcedAdd(args) {
  let forced = false;
  let all = false;
  let options = true;
  const pathspecs = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.dynamic || token.placeholder) { all = true; continue; }
    const value = token.value;
    if (options && value === '--') { options = false; continue; }
    if (options && value.startsWith('-')) {
      if (/^--for(?:ce?)?$/.test(value) || (/^-[A-Za-z]+$/.test(value) && value.includes('f'))) forced = true;
      else if (value.startsWith('--pathspec-from-file')) { all = true; if (!value.includes('=')) index += 1; }
      continue;
    }
    pathspecs.push(value);
  }
  return forced ? { all: all || pathspecs.length === 0, pathspecs } : null;
}

// `git config [set] [options] alias.<name> <value>`: [name, value], value null when dynamic.
function aliasDefinition(args) {
  const positional = [];
  for (let index = args[0]?.value === 'set' ? 1 : 0; index < args.length && positional.length < 2; index += 1) {
    const token = args[index];
    if (!token.dynamic && !token.placeholder && token.value.startsWith('-') && positional.length === 0) {
      if (CONFIG_VALUE_OPTIONS.has(token.value)) index += 1;
      continue;
    }
    positional.push(token);
  }
  const [key, value] = positional;
  if (!key || !value) return null;
  if (key.dynamic || key.placeholder) return ['*', null];
  if (!/^alias\./i.test(key.value)) return null;
  return [key.value.slice('alias.'.length).toLowerCase(), value.dynamic || value.placeholder ? null : value.value];
}

// Parses `git config -z --get-regexp '^alias\.'` output into name -> expansion.
export function parseGitAliases(text) {
  const aliases = new Map();
  for (const record of String(text || '').split('\0')) {
    const newline = record.indexOf('\n');
    if (!record.toLowerCase().startsWith('alias.')) continue;
    const key = newline < 0 ? record : record.slice(0, newline);
    aliases.set(key.slice('alias.'.length).toLowerCase(), newline < 0 ? '' : record.slice(newline + 1));
  }
  return aliases;
}

// `run(args)` returns a spawnSync-like result for `git <args>` in the repository. Git exits 1 when no
// alias is configured; any other failure throws so the caller can fail closed.
export function readGitAliases(run) {
  const result = run(['config', '-z', '--get-regexp', '^alias\\.']);
  if (!result.error && result.status === 1 && !String(result.stdout || '')) return new Map();
  if (result.error || result.status !== 0) {
    throw new Error(`Git aliases could not be read (${String(result.stderr || result.error?.message || 'unknown git error').trim()})`);
  }
  return parseGitAliases(result.stdout);
}

function aliasValue(name, invocation, state) {
  let value;
  for (const setting of invocation.globals.config) if (setting.key === `alias.${name}`) value = setting.value;
  if (value !== undefined) return value;
  if (state.localAliases.has(name)) return state.localAliases.get(name);
  if (state.localAliases.has('*')) return null;
  if (state.configured === undefined) {
    const source = state.aliases;
    state.configured = typeof source === 'function' ? source() : source instanceof Map ? source : new Map();
  }
  return state.configured.get(name);
}

function inspectGit(tokens, changedDirectory, state, depth) {
  const invocation = gitInvocation(tokens);
  if (invocation.ambiguous) return false;
  const { name, args } = invocation;
  if (!name) return true;
  if (!GIT_BUILTINS.has(name)) {
    const alias = aliasValue(name, invocation, state);
    // Not an alias: an external `git-<name>` program, which this analysis does not follow.
    if (alias === undefined) return true;
    if (alias === null || depth >= COMMIT_MAX_ALIAS_DEPTH) return false;
    if (alias.startsWith('!')) {
      // Git runs a shell alias with the arguments appended, from the top of the work tree.
      const nested = parseShellCommands(alias.slice(1));
      if (nested.error) return false;
      const last = nested.commands.at(-1);
      if (last?.tokens) last.tokens = [...last.tokens, ...args];
      for (const entry of nested.commands) entry.changedDirectory = true;
      return walk(nested.commands, state, depth + 1);
    }
    const expansion = parseShellCommands(`git ${alias}`);
    if (expansion.error || expansion.commands.length !== 1 || !expansion.commands[0].tokens) return false;
    const expanded = [tokens[0], ...tokens.slice(1, invocation.index), ...expansion.commands[0].tokens.slice(1), ...args];
    return inspectGit(expanded, changedDirectory, state, depth + 1);
  }
  if (name === 'config') {
    const definition = aliasDefinition(args);
    if (definition) state.localAliases.set(definition[0], definition[1]);
    return true;
  }
  if (name === 'commit') {
    state.found = true;
    state.unsupportedScope ||= changedDirectory || invocation.scoped;
    state.worktree ||= state.stagedEarlier || commitReadsWorkingTree(args);
    state.noVerify ||= commitSkipsHooks(args) || invocation.globals.config.some((setting) => setting.key === 'core.hookspath');
    return true;
  }
  if (COMMIT_STAGING_SUBCOMMANDS.has(name)) {
    state.stagedEarlier = true;
    const forced = (name === 'add' || name === 'stage') ? forcedAdd(args) : null;
    if (forced) {
      state.ignored ??= { all: false, pathspecs: [] };
      state.ignored.all ||= forced.all;
      state.ignored.pathspecs.push(...forced.pathspecs);
    }
  }
  return true;
}

function walk(commands, state, depth) {
  for (const entry of commands) {
    if (entry.ambiguous) return false;
    if (!entry.tokens?.length || executableName(entry.tokens[0]) !== 'git') continue;
    if (!inspectGit(entry.tokens, entry.changedDirectory, state, depth)) return false;
  }
  return true;
}

// What the `git commit` calls in a shell command will take. Returns { ambiguous: true } when the
// command cannot be analyzed, else { found, unsupportedScope, worktree, noVerify, ignored }:
// - unsupportedScope: a commit runs after cd/pushd or with -C/--git-dir/--work-tree;
// - worktree: a commit can take working-tree content (staged earlier in the command, -a, pathspec);
// - noVerify: a commit skips repository hooks (-n, --no-verify, -c core.hooksPath=…);
// - ignored: null, or { all, pathspecs } of ignored files that `git add -f` stages.
// `options.aliases` is a Map or a function returning one (read lazily, for example with
// readGitAliases); aliases defined in the command itself and by `git -c alias.x=…` win.
export function analyzeCommitContent(command, options = {}) {
  const parsed = parseShellCommands(command);
  if (parsed.error) return { ambiguous: true };
  const state = {
    aliases: options.aliases, configured: undefined, localAliases: new Map(),
    found: false, unsupportedScope: false, worktree: false, noVerify: false, stagedEarlier: false, ignored: null
  };
  if (!walk(parsed.commands, state, 0)) return { ambiguous: true };
  const { found, unsupportedScope, worktree, noVerify, ignored } = state;
  return { found, unsupportedScope, worktree, noVerify, ignored };
}
// </youdede:shared>

function cleanGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_LOCKFILE_BYTES = 2 * 1024 * 1024;
export const MAX_LOCKFILES = 24;

const LOCKFILE = /(?:^|\/)package-lock\.json$/i;

// A command the shared analysis cannot read blocks when it may hide a commit: its text names git,
// or a shell or eval layer runs a script that cannot be read.
function mayHideCommit(command) {
  if (/\bgit\b/.test(command)) return true;
  return parseShellCommands(command).commands.some((entry) => entry.ambiguous && entry.wrappers.some((name) => SHELL_NAMES.has(name) || name === 'eval'));
}

// 'irrelevant', 'uninspectable', or { worktree, ignored } for the commits in the command.
export function commitIntent(command, options = {}) {
  if (typeof command !== 'string' || !command) return 'irrelevant';
  const intent = analyzeCommitContent(command, options);
  if (intent.ambiguous) return mayHideCommit(command) ? 'uninspectable' : 'irrelevant';
  if (!intent.found) return 'irrelevant';
  if (intent.unsupportedScope) return 'uninspectable';
  return { worktree: intent.worktree, ignored: intent.ignored };
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

// Lockfiles a working-tree commit can take, read from disk: tracked files with unstaged changes,
// untracked non-ignored files, and the ignored files `git add -f` names.
function worktreeLockfiles(root, ignored) {
  const top = git(root, ['rev-parse', '--show-toplevel'], 64 * 1024).trim();
  const listed = git(top, ['ls-files', '-z', '--modified', '--others', '--exclude-standard'], 16 * 1024 * 1024);
  const forced = ignored ? git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--full-name', '--', ...(ignored.all ? [':/'] : ignored.pathspecs)], 16 * 1024 * 1024) : '';
  const files = [];
  for (const name of new Set(`${listed}\0${forced}`.split('\0').filter((entry) => LOCKFILE.test(entry)))) {
    let stat;
    try { stat = lstatSync(path.join(top, name)); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_LOCKFILE_BYTES) throw new Error('working-tree lockfile exceeds bounds');
    files.push({ name, content: readFileSync(path.join(top, name), 'utf8') });
  }
  return files;
}

export function collectContext(input, cwd = process.cwd()) {
  const command = input?.tool_input?.command ?? input?.toolInput?.command;
  const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
  let intent;
  try {
    intent = commitIntent(command, { aliases: () => readGitAliases((args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, env: cleanGitEnvironment() })) });
  } catch { return { relevant: true, invalid: true }; }
  if (intent === 'irrelevant') return { relevant: false };
  if (intent === 'uninspectable') return { relevant: true, invalid: true };
  try {
    const top = git(root, ['rev-parse', '--show-toplevel'], 64 * 1024).trim();
    const names = git(top, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], 256 * 1024)
      .split('\0').filter((name) => LOCKFILE.test(name));
    const worktree = intent.worktree ? worktreeLockfiles(root, intent.ignored) : [];
    if (names.length + worktree.length > MAX_LOCKFILES) throw new Error('too many lockfiles');
    const staged = [...names.map((name) => ({ name, content: git(top, ['show', `:${name}`]) })), ...worktree];
    return { relevant: true, staged };
  } catch { return { relevant: true, invalid: true }; }
}

export function evaluate(_input, state = {}) {
  if (!state.relevant) return { exitCode: 0 };
  if (state.invalid) return { exitCode: 2, ruleId: 'lockfile-origin-inspection-incomplete', message: 'Lockfile origins of the commit could not be inspected safely.' };
  try {
    for (const file of state.staged || []) {
      const finding = scanPackageLock(file.content)[0];
      if (finding) return { exitCode: 2, ruleId: finding.ruleId, message: 'A committed lockfile contains an unsafe or unverifiable dependency origin.' };
    }
    return { exitCode: 0 };
  } catch {
    return { exitCode: 2, ruleId: 'lockfile-origin-input-invalid', message: 'A committed lockfile was malformed or exceeded the bounded limit.' };
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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
