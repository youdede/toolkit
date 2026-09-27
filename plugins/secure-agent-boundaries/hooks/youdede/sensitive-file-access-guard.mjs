#!/usr/bin/env node

import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
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
// An assignment sets, appends to (`x+=`), or indexes (`a[1]=`) a variable.
const SHELL_SENSITIVE_ASSIGNMENT = /^(?:PATH|SHELL|GIT_DIR|GIT_WORK_TREE|GIT_CONFIG[^=]*?)(?:\[[^\]]*\])?\+?=/;
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
// Reserved words and precommand modifiers, from the GNU Bash Reference Manual (§3.1.2.1 Reserved Words:
// `! case coproc do done elif else esac fi for function if in select then until while { } time [[ ]]`)
// and zsh 5.9 zshmisc(1) (RESERVED WORDS: `do done esac then elif else fi for case if while function
// repeat time until select coproc nocorrect foreach end ! [[ { } declare export float integer local
// readonly typeset`; PRECOMMAND MODIFIERS: `-`, builtin, command, exec, nocorrect, noglob).
// Prefix words precede a command (`if true; then rm -rf /; fi` runs rm; zsh `nocorrect rm`, `- rm`).
// Skipped words end a compound command, start a header whose words are not a command (`for x in …`,
// `case … in`, `foreach x (…)`), or open a conditional that runs nothing (`[[ -f x ]]`). `coproc`,
// `repeat`, and `function` are handled where they are read; `time`, `exec`, `command`, `builtin`, and
// `noglob` are wrappers; the declaration words are ordinary commands. Any other reserved word in
// command position is ambiguous rather than taken for an executable.
const SHELL_PREFIX_KEYWORDS = new Set(['!', '{', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'nocorrect', '-']);
const SHELL_SKIPPED_KEYWORDS = new Set(['}', 'fi', 'done', 'esac', 'for', 'select', 'case', 'foreach', 'end', 'in', '[[', ']]']);
const SHELL_RESERVED = new Set([
  '!', 'case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'select', 'then',
  'until', 'while', '{', '}', 'time', '[[', ']]', 'repeat', 'nocorrect', 'foreach', 'end', 'declare', 'export',
  'float', 'integer', 'local', 'readonly', 'typeset'
]);
const SHELL_KNOWN_RESERVED = new Set([...SHELL_PREFIX_KEYWORDS, ...SHELL_SKIPPED_KEYWORDS, 'coproc', 'repeat', 'function', 'time',
  'declare', 'export', 'float', 'integer', 'local', 'readonly', 'typeset']);
// Words that start a compound command: after `coproc NAME` they mark NAME as the coprocess name.
const SHELL_COMPOUND_STARTS = new Set(['{', 'if', 'while', 'until', 'for', 'case', 'select', '[[', 'repeat', 'foreach']);
// Wrappers after which a shell still looks up its functions: `time f`, zsh `noglob f`, and zsh
// `exec f` (bash's `exec f` does not; the hook does not know the shell, so it keeps the body). zsh
// `nocorrect f` and `- f` are prefix words and find functions too. `command f` and `builtin f` find no
// function in bash or zsh 5.9, and the external-command wrappers (`env`, `sudo`, `nohup`, …) never do.
const SHELL_FUNCTION_WRAPPERS = new Set(['time', 'noglob', 'exec']);
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
  exec: { next: /^-a$/, alone: /^-[cl]+$/ },
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

// Bash ANSI-C quoting `$'…'` opening at `start` (the `$`): { end, value }, with `value` null when an
// escape is not decoded with certainty (a NUL, which ends the string in bash, a non-ASCII byte or code
// point, whose bytes depend on the locale, an unknown escape, or a `\c` before a non-letter), and
// null for an unterminated string. Escapes follow the GNU Bash Reference Manual, §3.1.2.4 ANSI-C Quoting.
const ANSI_C_ESCAPES = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
function ansiCString(source, start) {
  let value = '';
  let certain = true;
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'") return { end: index + 1, value: certain ? value : null };
    if (character !== '\\') { value += character; continue; }
    const escape = source[index + 1] ?? '';
    const numeric = /^(?:[0-7]{1,3}|x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8})/.exec(source.slice(index + 1, index + 10));
    if (numeric) {
      const text = numeric[0];
      const code = /^[0-7]/.test(text) ? parseInt(text, 8) : parseInt(text.slice(1), 16);
      if (code > 0 && code < 0x80) value += String.fromCharCode(code); else certain = false;
      index += text.length;
    } else if (escape === 'c' && /[A-Za-z]/.test(source[index + 2] ?? '')) {
      value += String.fromCharCode(source.charCodeAt(index + 2) & 0x1f);
      index += 2;
    } else if (escape in ANSI_C_ESCAPES) {
      value += ANSI_C_ESCAPES[escape];
      index += 1;
    } else {
      certain = false;
      index += 1;
    }
  }
  return null;
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
// of a `${…}` (`${x:-<(cmd)}`), and not between quotes there (`${x:-'<(cmd)'}` is text); in a
// here-document body or `$((…))` they are text or comparisons. `$(…)` and backticks count even between
// single quotes: inside a double-quoted `${…}` bash still runs them, and this text does not say which.
function scanSubstitutions(text, found, processSubstitutions = false) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== "'" && character === '\\') { index += 1; continue; }
    if (processSubstitutions && (character === "'" || character === '"') && (!quote || quote === character)) {
      quote = quote ? null : character;
      continue;
    }
    const substitution = processSubstitutions && !quote && (character === '<' || character === '>') && text[index + 1] === '(';
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
// ends the segment: `&&`, `||`, `;`, `|`, `&`, `\n`, `(`, `)`, or '' at the end; a function header
// (`name()`, `function name ()`) is a segment of its own that ends with `()`. An array assignment
// (`arr=(a b)`, `x+=(…)`, also as the argument of `declare`/`local`) stays one token: its elements are
// data, and only the substitutions in them run. Redirections, in any
// position (`>out npm publish` runs npm), always leave the tokens and go to `redirections` as
// { operator, target }: `2>&1` is { operator: '2>&', target: '1' }, `x>out` is the token x and
// { operator: '>', target: 'out' }, a here-document's target carries its `heredoc`.
function lexShell(source, options = {}) {
  const segments = [];
  let tokens = [];
  let redirections = [];
  let redirect = null;
  let token = null;
  let quote = null;
  let substitutions = [];
  let heredocs = [];
  let array = false;
  let redirectVariable = {};
  // Bash's `{name}` before an operator allocates a descriptor and stores it in name: it leaves the
  // tokens, the operator stays the plain one (`{fd}>out` is `>` to out), and `variable` keeps the name.
  const fdVariable = () => {
    if (!token || token.quoted || token.dynamic || !/^\{[A-Za-z_]\w*\}$/.test(token.value)) return {};
    const variable = token.value.slice(1, -1);
    token = null;
    return { variable };
  };
  const begin = () => { if (!token) token = { value: '', dynamic: false }; };
  // Text known only at run time: `cuts` marks where it sits in the value, so `bare` can drop it.
  const unknown = (text) => {
    (token.cuts ??= []).push([token.value.length, token.value.length + text.length]);
    token.value += text; token.dynamic = true;
  };
  const expansion = (index) => {
    const end = expansionEnd(source, index);
    if (end < 0 || !collectSubstitutions(source.slice(index, end), substitutions)) return -1;
    unknown(source.slice(index, end));
    return end;
  };
  const pushToken = () => {
    if (!token) return;
    // Only `{a,b}` and `{x..y}` expand; `{}` and `stash@{0}` are literal.
    if (token.braces && /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(token.value)) token.dynamic = true;
    delete token.braces;
    delete token.quoted;
    // `bare` is a dynamic token's value with its run-time text removed (`n${x}pm` is `npm`).
    if (token.cuts) token.bare = token.cuts.reduceRight((text, [from, to]) => text.slice(0, from) + text.slice(to), token.value);
    delete token.cuts;
    if (redirect) { redirections.push({ operator: redirect, target: token, ...redirectVariable }); redirect = null; } else tokens.push(token);
    token = null;
  };
  const pushSegment = (operator) => {
    pushToken();
    if (redirect) return false;
    if (tokens.length || redirections.length) segments.push({ tokens, operator, redirections, substitutions });
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
        // Between double quotes bash removes a backslash only before $, `, ", \, and a newline.
        if (!'$`"\\\n'.includes(source[index])) token.value += '\\';
        if (source[index] !== '\n') token.value += source[index];
      } else if (character === '$' || character === '`') {
        const end = expansion(index);
        if (end < 0) return { error: 'unterminated expansion' };
        index = end - 1;
      } else token.value += character;
      continue;
    }
    if (character === '\\' && source[index + 1] === '\n') { index += 1; continue; }
    if (array) {
      // Inside `arr=( … )` blanks separate elements and `)` closes the list; an operator is a syntax error.
      if (/\s/.test(character)) { token.value += ' '; continue; }
      if (character === ')') { token.value += ')'; array = false; continue; }
      if (';&|('.includes(character) || ((character === '<' || character === '>') && source[index + 1] !== '(')) return { error: 'invalid array' };
    }
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
    else if (character === '$' && source[index + 1] === "'") {
      // `$'…'` is a quoted fragment of the word, decoded; one not known for certain is run-time text.
      const ansi = ansiCString(source, index);
      if (!ansi) return { error: 'unterminated quote' };
      begin(); token.quoted = true;
      if (ansi.value === null) unknown(source.slice(index, ansi.end)); else token.value += ansi.value;
      index = ansi.end - 1;
    } else if (character === '$' && source[index + 1] === '"') {
      // `$"…"` is a locale-translated string: read as a double-quoted one.
      begin(); token.quoted = true; quote = '"'; index += 1;
    } else if (character === '$' || character === '`' || ((character === '<' || character === '>') && source[index + 1] === '(')) {
      begin();
      const end = expansion(index);
      if (end < 0) return { error: 'unterminated expansion' };
      index = end - 1;
    } else if (isHeredocStart(source, index)) {
      const heredoc = readHeredoc(source, index);
      if (!heredoc) return { error: 'redirection without target' };
      let operator = heredoc.operator;
      // A file descriptor written right before the operator belongs to it (`0<<EOF`, `{fd}<<EOF`).
      const variable = fdVariable();
      if (token && !token.quoted && !token.dynamic && /^\d+$/.test(token.value)) { operator = token.value + operator; token = null; }
      pushToken();
      if (redirect) return { error: 'redirection without target' };
      redirections.push({ operator, target: { value: heredoc.delimiter, dynamic: false, heredoc }, ...variable });
      // The body of an unquoted delimiter is attached to this segment when it is read.
      heredoc.owner = substitutions;
      heredocs.push(heredoc);
      index = heredoc.end - 1;
    } else if (character === '<' || character === '>' || (character === '&' && source[index + 1] === '>')) {
      // A file descriptor written right before the operator belongs to it: a number, or bash's
      // `{name}` (`{fd}>out npm publish` runs npm).
      const variable = character === '&' ? {} : fdVariable();
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
      redirectVariable = variable;
    } else if (character === '(' && token && !token.dynamic && !token.quoted && !redirect && /^[A-Za-z_]\w*\+?=$/.test(token.value)) {
      token.value += '(';
      array = true;
    } else if (';&|()'.includes(character)) {
      let operator = character;
      if (character === '(') {
        // `name ()`: a function definition header, whose name may follow reserved words (`then f()`).
        pushToken();
        const close = /[ \t]*\)/y;
        close.lastIndex = index + 1;
        const name = tokens.at(-1);
        const header = name && !name.dynamic && !redirect && !redirections.length && close.test(source)
          && tokens.slice(0, -1).every((word) => !word.dynamic && (SHELL_PREFIX_KEYWORDS.has(word.value) || word.value === 'function'));
        if (header) { operator = '()'; index = close.lastIndex - 1; }
      }
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
  if (array) return { error: 'invalid array' };
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

// `redirections` are those of the segment: a shell without -c reads its program from standard input.
function unwrapCommand(original, depth, inherited = [], parseOptions = {}, redirections = []) {
  let tokens = original;
  let index = 0;
  const wrappers = [...inherited];
  const ambiguous = () => [{ ambiguous: true, wrappers }];
  while (index < tokens.length && !tokens[index].dynamic) {
    const word = tokens[index].value;
    // `function name { …`: the body starts after the name. zsh `repeat N cmd` runs cmd N times.
    if (word === 'function' || word === 'repeat') index += 2;
    else if (word === 'coproc') {
      // `coproc NAME { …; }` names the coprocess; `coproc cmd args` runs cmd. A lone NAME before a
      // subshell (`coproc NAME ( … )`, split here) cannot be told apart from a command: ambiguous.
      const [name, after] = tokens.slice(index + 1, index + 3);
      const named = name && !name.dynamic && /^[A-Za-z_]\w*$/.test(name.value) && (!after || (!after.dynamic && SHELL_COMPOUND_STARTS.has(after.value)));
      if (named && !after) return ambiguous();
      index += named ? 2 : 1;
    } else if (SHELL_PREFIX_KEYWORDS.has(word)) index += 1;
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
    if (SHELL_RESERVED.has(executable.value) && !SHELL_KNOWN_RESERVED.has(executable.value)) return ambiguous();
    // `time` times a pipeline, so `time ! cmd` runs cmd; any other prefix word after a wrapper
    // (`sudo nocorrect cmd`) is not an executable either, and is ambiguous.
    if (count > 0 && (SHELL_PREFIX_KEYWORDS.has(executable.value) || executable.value === 'coproc')) {
      if (wrappers.at(-1) === 'time' && executable.value === '!') { index += 1; continue; }
      return ambiguous();
    }
    const name = executableName(executable);
    if (/^(?:pwsh|powershell)(?:\.exe)?$/.test(name)) return powershellCommands(tokens, index, depth, wrappers, name.replace(/\.exe$/, ''), parseOptions);
    if (SHELL_NAMES.has(name) || name === 'eval') {
      let payload = name === 'eval' ? index + 1 : -1;
      if (name !== 'eval') {
        // With -c the command string is the first operand, after every option and `--`. Without it the
        // shell runs its standard input (`… | sh`, `sh -s`, `bash < file`), whose text the command itself
        // supplies and the hook cannot see, or a script file, which is judged like any other program
        // (`./script.sh` and `make` are not read either).
        // A here-string or here-document on standard input (no descriptor number, or 0) gives the shell
        // its program: a static one is read as commands. Every other input redirection (`< file`, `0<>`,
        // `<&3`, a here-string on another descriptor) is ambiguous. Their words are never a script name.
        // The last input wins, as in bash.
        const feeds = [];
        for (const { operator, target, variable } of redirections) {
          const input = /^(\d*)(<<-?|<<<|<>|<&|<)$/.exec(operator);
          if (!input) continue;
          // `{fd}<<<text` feeds a new descriptor, not standard input.
          const stdinFeed = !variable && (input[1] === '' || input[1] === '0');
          if (target.heredoc) {
            const { body, quoted } = target.heredoc;
            feeds.push(stdinFeed && (quoted || !/[$`\\]/.test(body)) ? { text: body } : { dynamic: true });
          } else if (input[2] === '<<<') {
            feeds.push(stdinFeed && !target.dynamic && !target.placeholder ? { text: target.value } : { dynamic: true });
          } else feeds.push({ dynamic: true });
        }
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
        if (!command && feeds.length && (stdin || !tokens[cursor])) {
          const feed = feeds.at(-1);
          if (feed.dynamic || depth >= SHELL_MAX_DEPTH) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
          const nested = parseShellCommands(feed.text, depth + 1, [...wrappers, name], parseOptions);
          return nested.error ? [{ ambiguous: true, wrappers: [...wrappers, name] }] : nested.commands;
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
  // `exec >log 2>&1` only applies its redirections: nothing runs.
  if (index >= tokens.length && wrappers.length === inherited.length + 1 && wrappers.at(-1) === 'exec') return [];
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
// segment it came from, and `text`, that segment with its run-time text removed, so a hook can still
// judge it. A function definition runs
// nothing: the commands of a `{ … }` body are kept aside and stand in for each later call of the name
// that looks up functions in bash or zsh (bare, or after `!`, `time`, `noglob`, `exec`, a reserved word;
// not after `command`, `builtin`, `env`, `sudo`, or another wrapper, where the name is an ordinary executable),
// in this text and in the shells and substitutions it nests (fail closed: a nested shell sees them too).
// ponytail: only a `{ … }` body is kept aside; any other body (`f() ( … )`) is read as if it ran now.
export function parseShellCommands(command, depth = 0, wrappers = [], options = {}) {
  if (typeof command !== 'string') return { commands: [] };
  if (!options.functions) options = { ...options, functions: new Map() };
  const { functions } = options;
  if (Buffer.byteLength(command, 'utf8') > SHELL_MAX_COMMAND_BYTES) return { error: 'command exceeds analysis limit', commands: [] };
  const lexed = lexShell(command, options);
  if (lexed.error) return { error: lexed.error, commands: [] };
  const commands = [];
  const loops = new Map();
  const isWord = (token, value) => Boolean(token) && !token.dynamic && token.value === value;
  let header = null;
  let body = null;
  for (const segment of lexed.segments) {
    if (segment.operator === '()') { header = segment.tokens.at(-1).value; continue; }
    if (!body) {
      const [first, name, open] = segment.tokens.slice(segment.tokens.findIndex((token) => token.dynamic || !SHELL_PREFIX_KEYWORDS.has(token.value)));
      // `function name` then newlines, then `{`: the header waits for its body like `name()`.
      if (isWord(first, 'function') && name && !name.dynamic && !open && segment.operator === '\n') { header = name.value; continue; }
      if (header && isWord(segment.tokens[0], '{')) body = { name: header, depth: 0, commands: [] };
      else if (isWord(first, 'function') && name && !name.dynamic && isWord(open, '{')) {
        body = { name: name.value, depth: 0, commands: [] };
        segment.tokens = segment.tokens.slice(segment.tokens.indexOf(open));
      }
    }
    header = null;
    const output = body ? body.commands : commands;
    if (body) {
      // `{` opens and `}` closes a group only where a command starts.
      for (const token of segment.tokens) {
        if (isWord(token, '{')) body.depth += 1;
        else if (isWord(token, '}')) body.depth -= 1;
        else if (token.dynamic || !SHELL_PREFIX_KEYWORDS.has(token.value)) break;
      }
    }
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
      output.push(...inner);
    }
    let entries = unwrapCommand(segment.tokens, depth, wrappers, options, segment.redirections)
      .flatMap((entry) => (entry.tokens?.length && functions.has(entry.tokens[0].value) && !entry.tokens[0].dynamic
        && entry.wrappers.slice(wrappers.length).every((wrapper) => SHELL_FUNCTION_WRAPPERS.has(wrapper))
        ? functions.get(entry.tokens[0].value).map((call) => ({ ...call }))
        : [entry]));
    if (options.redirections && segment.redirections.length) {
      if (!entries.length) entries = [{ tokens: [], wrappers: [...wrappers] }];
      for (const entry of entries) entry.redirections = [...(entry.redirections ?? []), ...segment.redirections];
    }
    // Nested entries keep their inner operator; the last one, and a find action, take the segment's.
    if (entries.length) entries.at(-1).operator = segment.operator;
    for (const entry of entries) {
      entry.operator ??= segment.operator;
      if (entry.ambiguous) {
        entry.segment ??= segment.tokens;
        // The segment with run-time text removed, so a hook still sees a word split by it (`n${x}pm`).
        entry.text ??= entry.segment.map((token) => token.bare ?? token.value).join(' ');
      }
    }
    output.push(...entries);
    if (body && body.depth <= 0) { functions.set(body.name, body.commands); body = null; }
  }
  // A body left open is a syntax error, and nothing runs; its commands are kept (fail closed).
  if (body) commands.push(...body.commands);
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
export const MAX_COMMAND_BYTES = SHELL_MAX_COMMAND_BYTES;
export const MAX_PATH_BYTES = 4096;
export const MAX_PATHS = 32;
export const MAX_PATH_COMPONENTS = 64;

const DIRECT_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit', 'grep']);
const DIRECT_TARGET_REQUIRED = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);
const SIMPLE_FILE_COMMANDS = new Set([
  '.', 'base64', 'bat', 'cat', 'chmod', 'chown', 'cmp', 'code', 'copy-item', 'cp', 'cut', 'diff', 'get-content',
  'curl', 'dd', 'gc', 'head', 'install', 'less', 'ln', 'more', 'move-item', 'mv', 'nano', 'nl', 'od',
  'out-file', 'remove-item', 'rm', 'rsync', 'scp', 'select-string', 'set-content', 'sort', 'source', 'strings',
  'tac', 'tail', 'tar', 'tee', 'type', 'uniq', 'vim', 'vi', 'wc', 'xxd', 'zip'
]);
const SEARCH_COMMANDS = new Set(['grep', 'rg']);
const SCRIPT_COMMANDS = new Set(['awk', 'jq', 'sed']);
// Transfers read every operand but the last, which is the destination.
const TRANSFER_COMMANDS = new Set(['rsync', 'scp']);
const OPTION_PATHS = new Map([
  ['grep', new Set(['-f', '--file'])],
  ['rg', new Set(['-f', '--file', '--ignore-file', '--type-add'])],
  ['sed', new Set(['-f', '--file'])],
  ['jq', new Set(['-f', '--from-file'])],
  ['awk', new Set(['-f', '--file'])],
  ['openssl', new Set(['-in', '-out', '-key', '-cert', '-config'])],
  ['curl', new Set(['-K', '--config', '--netrc-file', '--key', '--cert', '-H', '--header', '-T', '--upload-file'])],
  ['dd', new Set(['if', 'of'])]
]);

export const MAX_RECURSIVE_ENTRIES = 20000;
export const MAX_GITIGNORE_ENTRIES = 200000;
// Options whose value is the next token; without this the value would be read as a path operand.
const VALUE_OPTIONS = new Map([
  ['grep', new Set(['--exclude', '--exclude-dir', '--include', '-d', '--directories', '-m', '--max-count', '-A', '-B', '-C', '--context'])],
  ['rg', new Set(['-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '-j', '--threads'])],
  ['scp', new Set(['-c', '-D', '-F', '-i', '-J', '-l', '-o', '-P', '-S', '-X'])],
  ['rsync', new Set(['-e', '--rsh', '--exclude', '--include', '--exclude-from', '--include-from', '--files-from', '--filter', '-f', '--port', '--password-file', '--chmod', '--chown', '--log-file', '--temp-dir', '-T', '--partial-dir', '--compare-dest', '--copy-dest', '--link-dest', '--backup-dir', '--suffix', '--timeout', '--bwlimit', '--max-size', '--min-size', '--usermap', '--groupmap'])]
]);
export const MAX_GLOB_MATCHES = 1024;

export function globToRegExp(glob) {
  let source = '';
  let braces = 0;
  for (const character of glob) {
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '{') { braces += 1; source += '(?:'; }
    else if (character === '}' && braces > 0) { braces -= 1; source += ')'; }
    else if (character === ',' && braces > 0) source += '|';
    else source += character.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return braces === 0 ? new RegExp(`^${source}$`) : null;
}

// A glob that cannot be translated is dropped, so nothing is excluded by it: the walk then sees
// more files, never fewer.
function compileGlobs(values) {
  return values.map((value) => globToRegExp(value.split('/').at(-1))).filter(Boolean);
}

function optionValues(tokens, names) {
  const values = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    const equals = value.indexOf('=');
    const name = equals < 0 ? value : value.slice(0, equals);
    if (!names.has(name)) continue;
    if (equals >= 0) values.push(value.slice(equals + 1));
    else if (tokens[index + 1]) values.push(tokens[index + 1].value);
  }
  return values;
}

function recursiveReadMode(executable, tokens) {
  const values = tokens.slice(1).map((token) => token.value);
  if (executable === 'grep') {
    const recursive = values.some((value) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(value)
      || ['--recursive', '--dereference-recursive', '--directories=recurse'].includes(value))
      || values.some((value, index) => value === '-d' && values[index + 1] === 'recurse');
    if (!recursive) return null;
    return {
      hidden: true,
      respectsGitignore: false,
      excludes: compileGlobs(optionValues(tokens, new Set(['--exclude']))),
      excludeDirs: compileGlobs(optionValues(tokens, new Set(['--exclude-dir']))),
      includes: compileGlobs(optionValues(tokens, new Set(['--include'])))
    };
  }
  if (executable === 'rg') {
    const globs = optionValues(tokens, new Set(['-g', '--glob']));
    return {
      hidden: values.some((value) => value === '--hidden' || value === '-.' || /^-u{2,}$/.test(value)),
      respectsGitignore: !values.some((value) => /^-u+$/.test(value) || value === '--no-ignore' || value === '--no-ignore-vcs'),
      excludes: compileGlobs(globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1))),
      excludeDirs: [],
      includes: compileGlobs(globs.filter((glob) => !glob.startsWith('!')))
    };
  }
  if (executable === 'tar') {
    return { hidden: true, respectsGitignore: false, excludes: compileGlobs(optionValues(tokens, new Set(['--exclude']))), excludeDirs: [], includes: [] };
  }
  if (executable === 'cp') {
    const recursive = values.some((value) => /^-[A-Za-z]*[rRa][A-Za-z]*$/.test(value) || ['--recursive', '--archive'].includes(value));
    return recursive ? { hidden: true, respectsGitignore: false, excludes: [], excludeDirs: [], includes: [] } : null;
  }
  if (executable === 'rsync') {
    const recursive = values.some((value) => /^-[A-Za-z]*[ra][A-Za-z]*$/.test(value) || ['--recursive', '--archive'].includes(value));
    return recursive ? { hidden: true, respectsGitignore: false, excludes: compileGlobs(optionValues(tokens, new Set(['--exclude']))), excludeDirs: compileGlobs(optionValues(tokens, new Set(['--exclude']))), includes: [] } : null;
  }
  if (executable === 'scp') {
    const recursive = values.some((value) => /^-[A-Za-z]*r[A-Za-z]*$/.test(value));
    return recursive ? { hidden: true, respectsGitignore: false, excludes: [], excludeDirs: [], includes: [] } : null;
  }
  if (executable === 'zip') {
    const recursive = values.some((value) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(value) || value === '--recurse-paths');
    return recursive ? { hidden: true, respectsGitignore: false, excludes: [], excludeDirs: [], includes: [] } : null;
  }
  return null;
}

export function directoryHoldsSensitive(root, options) {
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return { error: true }; }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_RECURSIVE_ENTRIES) return { error: true };
      if (!options.hidden && entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // ponytail: .git is skipped for speed; its config can hold a credential URL, which this
        // guard never listed as a protected path. Add it here if that list grows.
        if (entry.name === '.git' || options.excludeDirs.some((pattern) => pattern.test(entry.name))) continue;
        if (isSensitivePath(absolute)) return { sensitive: true };
        pending.push(absolute);
        continue;
      }
      if (options.excludes.some((pattern) => pattern.test(entry.name))) continue;
      if (options.includes.length && !options.includes.some((pattern) => pattern.test(entry.name))) continue;
      if (isSensitivePath(absolute)) return { sensitive: true };
    }
  }
  return { sensitive: false };
}

function cleanGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}

// Lists what a gitignore-aware search would visit. Returns null when git cannot answer, so the
// caller falls back to the gitignore-unaware walk and sees more files, never fewer.
export function gitVisibleHoldsSensitive(root, options) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', root, 'ls-files', '-z', '-s', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8', env: cleanGitEnvironment(), maxBuffer: MAX_GITIGNORE_ENTRIES * 256, shell: false, timeout: 3000, windowsHide: true
  });
  if (result.error?.code === 'ENOBUFS') return { error: true };
  if (result.error || result.status !== 0) return null;
  const entries = result.stdout.split('\0').filter(Boolean);
  if (entries.length > MAX_GITIGNORE_ENTRIES) return { error: true };
  for (const entry of entries) {
    // `-s` prefixes tracked entries with mode, object, and stage; untracked entries are bare paths.
    const staged = /^(\d{6}) [0-9a-f]+ \d\t(.*)$/s.exec(entry);
    const file = staged ? staged[2] : entry;
    const parts = file.split('/').filter(Boolean);
    if (!options.hidden && parts.some((part) => part.startsWith('.'))) continue;
    if (parts.slice(0, -1).some((part) => options.excludeDirs.some((pattern) => pattern.test(part)))) continue;
    const absolute = path.join(root, file);
    // Submodules (mode 160000) and untracked nested repositories (trailing slash) are opaque to
    // this listing, so they are walked without gitignore rules.
    if (staged?.[1] === '160000' || file.endsWith('/')) {
      if (options.excludeDirs.some((pattern) => pattern.test(parts.at(-1)))) continue;
      const nested = directoryHoldsSensitive(absolute, options);
      if (nested.sensitive || nested.error) return nested;
      continue;
    }
    const name = parts.at(-1);
    if (options.excludes.some((pattern) => pattern.test(name))) continue;
    if (options.includes.length && !options.includes.some((pattern) => pattern.test(name))) continue;
    if (isSensitivePath(absolute)) return { sensitive: true };
  }
  return { sensitive: false };
}

const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];
// A credential directory is sensitive itself and so is everything under it, at any depth; `.ssh` keeps
// its own rule because its public keys, config, and known_hosts are safe.
const SENSITIVE_DIRECTORY_SUFFIXES = ['/.aws', '/.azure', '/.config/gcloud', '/.gnupg', '/.kube', '/.ssh'];
const SAFE_SSH_FILES = new Set(['authorized_keys', 'config', 'known_hosts']);
const EXACT_CREDENTIAL_SUFFIXES = [
  '/.aws/credentials',
  '/.azure/accessTokens.json',
  '/.config/gcloud/application_default_credentials.json',
  '/.config/gh/hosts.yml',
  '/.docker/config.json',
  '/.git-credentials',
  '/.kube/config',
  '/.netrc',
  '/.npmrc',
  '/.pypirc'
].map((entry) => entry.toLowerCase());
const SSH_PRIVATE_KEY = /\/(?:\.ssh\/)?id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i;

function allowed() {
  return { exitCode: 0, ruleId: null, message: '' };
}

function blocked(ruleId, reason) {
  return {
    exitCode: 2,
    ruleId,
    message: `BLOCKED by sensitive-file-access-guard [${ruleId}]: ${reason}. The submitted path and content were not printed.`
  };
}

function inputToolName(input) {
  return String(input?.tool_name ?? input?.toolName ?? '').split('__').at(-1).toLowerCase();
}

function toolInput(input) {
  return input?.tool_input ?? input?.toolInput ?? input ?? {};
}

function commandName(token) {
  return executableName(token).replace(/\.exe$/i, '');
}

// `git show HEAD:.env`, `git cat-file -p :.env`: the path part of a <revision>:<path> argument.
function gitBlobPaths(tokens) {
  const invocation = gitInvocation(tokens);
  if (invocation.ambiguous || !['show', 'cat-file'].includes(invocation.name)) return [];
  const paths = [];
  for (const token of invocation.args) {
    const match = /^[^:-][^:]*:(?:[0-3]:)?(.+)$|^:(?:[0-3]:)?(.+)$/.exec(token.value);
    if (match) paths.push({ ...token, value: match[1] ?? match[2] });
  }
  return paths;
}

function pathOperands(tokens) {
  const candidates = [];
  if (!tokens.length) return { candidates };
  // --env-file names an environment file for node, deno, bun, docker, and docker compose.
  for (let index = 1; index < tokens.length; index += 1) {
    const match = /^--env-file(?:-if-exists)?(?:=(.*))?$/.exec(tokens[index].value);
    if (!match) continue;
    if (match[1] !== undefined) candidates.push({ ...tokens[index], value: match[1] });
    else if (tokens[index + 1]) candidates.push(tokens[++index]);
  }
  const executable = commandName(tokens[0]);
  if (executable === 'git') candidates.push(...gitBlobPaths(tokens));
  if (!SIMPLE_FILE_COMMANDS.has(executable) && !SEARCH_COMMANDS.has(executable)
    && !SCRIPT_COMMANDS.has(executable) && !OPTION_PATHS.has(executable)) {
    return { candidates };
  }

  const positionals = [];
  let explicitPattern = false;
  const optionPaths = OPTION_PATHS.get(executable) ?? new Set();
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const exactOption = token.value.split('=')[0];
    if (optionPaths.has(exactOption)) {
      explicitPattern = true;
      const attached = token.value.includes('=') ? token.value.slice(token.value.indexOf('=') + 1) : null;
      if (attached !== null) candidates.push({ ...token, value: attached });
      else if (tokens[index + 1]) candidates.push(tokens[++index]);
      continue;
    }
    if (['-e', '--regexp', '--expression'].includes(exactOption)) {
      explicitPattern = true;
      if (!token.value.includes('=')) index += 1;
      continue;
    }
    if (VALUE_OPTIONS.get(executable)?.has(token.value)) { index += 1; continue; }
    if (token.value === '--') {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (token.value.startsWith('-') && !token.dynamic && !token.placeholder) continue;
    positionals.push(token);
  }

  let operands = [];
  if (SEARCH_COMMANDS.has(executable) || SCRIPT_COMMANDS.has(executable)) operands = positionals.slice(explicitPattern ? 0 : 1);
  else if (SIMPLE_FILE_COMMANDS.has(executable)) operands = positionals;
  const recursive = recursiveReadMode(executable, tokens);
  if (recursive && operands.length === 0 && SEARCH_COMMANDS.has(executable)) operands = [{ value: '.', dynamic: false }];
  const read = TRANSFER_COMMANDS.has(executable) && operands.length > 1 ? operands.slice(0, -1) : operands;
  candidates.push(...(recursive ? read.map((token) => ({ ...token, recursive })) : read), ...operands.slice(read.length));
  return { candidates };
}

// What `find` visits: its start paths, walked with hidden files, keeping only names that match
// its -name/-iname tests. With -o or `,` any file can match, so no name test narrows the walk.
function findTargets(tokens) {
  let index = 1;
  while (index < tokens.length && /^-(?:[HLP]|O\d*)$/.test(tokens[index].value)) index += 1;
  const starts = [];
  while (index < tokens.length && !/^[-(!),]/.test(tokens[index].value)) starts.push(tokens[index++]);
  const includes = [];
  let alternatives = false;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const value = tokens[cursor].value;
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(value)) {
      while (cursor < tokens.length && tokens[cursor].value !== ';' && tokens[cursor].value !== '+') cursor += 1;
      continue;
    }
    if (['-o', '-or', ','].includes(value)) alternatives = true;
    if ((value === '-name' || value === '-iname') && tokens[cursor + 1]) {
      const test = tokens[cursor + 1];
      const pattern = test.dynamic ? null : globToRegExp(test.value);
      if (pattern && !['!', '-not'].includes(tokens[cursor - 1]?.value)) includes.push(value === '-iname' ? new RegExp(pattern.source, 'i') : pattern);
      cursor += 1;
    }
  }
  const recursive = { hidden: true, respectsGitignore: false, excludes: [], excludeDirs: [], includes: alternatives ? [] : includes };
  return (starts.length ? starts : [{ value: '.', dynamic: false }]).map((start) => ({ ...start, recursive }));
}

// Words a pipe gives to xargs: the static arguments of echo or printf, or the files find lists.
function pipedWords(producer) {
  if (!producer || producer.ambiguous || producer.operator !== '|' || !producer.tokens?.length) return null;
  const name = commandName(producer.tokens[0]);
  if (name === 'find') return findTargets(producer.tokens);
  if (name !== 'echo' && name !== 'printf') return null;
  const args = producer.tokens.slice(1).filter((token, index) => !(name === 'echo' && index === 0 && /^-[neE]+$/.test(token.value)));
  if (args.some((token) => token.dynamic || token.glob || token.placeholder)) return null;
  return args.flatMap((token) => token.value.split(/\s+/).filter(Boolean)).map((value) => ({ value, dynamic: false }));
}

// The directory of later commands after cd or pushd: null for the input cwd, a path relative to
// it, or UNKNOWN_DIRECTORY after popd, `cd -`, a dynamic target, or the end of a subshell.
const UNKNOWN_DIRECTORY = Symbol('unknown directory');
function nextDirectory(directory, entry) {
  let next = directory;
  const name = entry.tokens?.length ? commandName(entry.tokens[0]) : '';
  if (name === 'popd') next = UNKNOWN_DIRECTORY;
  else if (name === 'cd' || name === 'pushd') {
    const args = entry.tokens.slice(1).filter((token) => token.value !== '--');
    const target = args[0];
    if (args.length !== 1 || target.dynamic || target.glob || target.placeholder || target.value.startsWith('-')) next = UNKNOWN_DIRECTORY;
    else if (path.isAbsolute(target.value) || target.value.startsWith('~')) next = target.value;
    else if (directory !== UNKNOWN_DIRECTORY) next = directory === null ? target.value : path.join(directory, target.value);
  }
  return entry.operator === ')' && next !== null ? UNKNOWN_DIRECTORY : next;
}

function directCandidates(data) {
  const values = [];
  for (const key of ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path']) {
    if (data?.[key] === undefined) continue;
    if (typeof data[key] !== 'string' || data[key].length === 0) return { invalid: true, values: [] };
    values.push({ value: data[key], dynamic: false });
  }
  if (data?.paths !== undefined) {
    if (!Array.isArray(data.paths) || data.paths.some((value) => typeof value !== 'string' || value.length === 0)) {
      return { invalid: true, values: [] };
    }
    for (const value of data.paths) values.push({ value, dynamic: false });
  }
  return { invalid: false, values };
}

export function collectCandidates(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { invalid: true, relevant: true, candidates: [] };
  const name = inputToolName(input);
  const data = toolInput(input);
  const hasCommand = typeof data?.command === 'string' || typeof input.command === 'string';
  if (DIRECT_TOOLS.has(name)) {
    const direct = directCandidates(data);
    const missing = DIRECT_TARGET_REQUIRED.has(name) && direct.values.length === 0;
    let candidates = direct.values;
    if (name === 'grep') {
      const grepTargets = direct.values.length ? direct.values : [{ value: '.', dynamic: false }];
      const include = typeof data?.glob === 'string' ? compileGlobs([data.glob]) : [];
      candidates = grepTargets.map((candidate) => ({ ...candidate, recursive: { hidden: true, respectsGitignore: true, excludes: [], excludeDirs: [], includes: include } }));
    }
    return {
      invalid: direct.invalid || missing,
      relevant: true,
      candidates: candidates.slice(0, MAX_PATHS),
      tooMany: candidates.length > MAX_PATHS
    };
  }
  if (!SHELL_TOOLS.has(name) && !hasCommand) return { invalid: false, relevant: false, candidates: [] };
  const command = data?.command ?? input.command;
  if (typeof command !== 'string') {
    return SHELL_TOOLS.has(name)
      ? { invalid: true, relevant: true, candidates: [] }
      : { invalid: false, relevant: false, candidates: [] };
  }
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) return { invalid: true, relevant: true, candidates: [] };
  const parsed = parseShellCommands(command, 0, [], { redirections: true });
  if (parsed.error) return { invalid: true, relevant: true, candidates: [] };
  const candidates = [];
  let ambiguous = false;
  let directory = null;
  let lastFind = null;
  parsed.commands.forEach((entry, index) => {
    const add = (candidate) => candidates.push({ ...candidate, directory });
    for (const { operator, target } of entry.redirections ?? []) {
      // Here-documents and here-strings carry text, and `2>&1` duplicates a descriptor.
      if (/<<[-<]?$/.test(operator) || (operator.endsWith('&') && /^(?:\d+|-)$/.test(target.value))) continue;
      add(target);
    }
    if (entry.ambiguous) { ambiguous = true; return; }
    if (entry.tokens.length && commandName(entry.tokens[0]) === 'find') lastFind = entry.tokens;
    for (const candidate of pathOperands(entry.tokens).candidates) {
      if (!candidate.placeholder) { add(candidate); continue; }
      // A word that find -exec or xargs supplies: the files find visits, or the words piped to xargs.
      const runner = entry.wrappers.at(-1);
      const supplied = runner === 'find' && lastFind ? findTargets(lastFind) : runner === 'xargs' ? pipedWords(parsed.commands[index - 1]) : null;
      if (!supplied) { ambiguous = true; continue; }
      for (const word of supplied) add(word.recursive || !candidate.recursive ? word : { ...word, recursive: candidate.recursive });
    }
    directory = nextDirectory(directory, entry);
  });
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const place = candidate.directory === UNKNOWN_DIRECTORY ? '?' : candidate.directory ?? '';
    const key = `${candidate.dynamic ? '1' : '0'}:${candidate.glob ? 'g' : ''}:${candidate.recursive ? 'r' : ''}:${place}:${candidate.value}`;
    if (!seen.has(key)) { seen.add(key); unique.push(candidate); }
  }
  return { invalid: false, relevant: true, candidates: unique.slice(0, MAX_PATHS), tooMany: unique.length > MAX_PATHS, ambiguous };
}

function normalizedPortablePath(value) {
  const slashed = String(value).replaceAll('\\', '/').replace(/^file:\/\//i, '');
  const prefix = slashed.startsWith('/') ? '/' : '';
  const parts = [];
  for (const part of slashed.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${prefix}${parts.join('/')}`;
}

export function isSensitivePath(value) {
  let candidate = String(value);
  const embedded = /^(?:@|<)(.+)$|^[^=@\s]+(?:=|@)[@<]?(.+)$/.exec(candidate);
  if (embedded) candidate = embedded[1] || embedded[2];
  const normalized = normalizedPortablePath(candidate).toLowerCase();
  const basename = normalized.split('/').at(-1);
  if (basename.startsWith('.env') && SAFE_ENV_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return false;
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (SSH_PRIVATE_KEY.test(normalized)) return true;
  if (normalized.includes('/.ssh/') && !basename.endsWith('.pub') && !SAFE_SSH_FILES.has(basename)) return true;
  if (SENSITIVE_DIRECTORY_SUFFIXES.some((suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix)
    || (suffix !== '/.ssh' && (normalized.startsWith(`${suffix.slice(1)}/`) || normalized.includes(`${suffix}/`))))) return true;
  return EXACT_CREDENTIAL_SUFFIXES.some((suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix));
}

function absoluteCandidate(value, cwd) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.resolve(os.homedir(), value.slice(2));
  return path.resolve(cwd, value);
}

function inspectPath(value, cwd) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) return { error: true };
  if (!value || value === '-' || /^https?:\/\//i.test(value)) return { skipped: true };
  const absolute = absoluteCandidate(value, cwd);
  const root = path.parse(absolute).root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  if (parts.length > MAX_PATH_COMPONENTS) return { error: true };
  let current = root;
  let hasSymlink = false;
  let exists = true;
  let existing = root;
  let missing = [];
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      current = path.join(current, part);
      try {
        const metadata = lstatSync(current);
        if (metadata.isSymbolicLink()) hasSymlink = true;
        existing = current;
      } catch (error) {
        if (error?.code === 'ENOENT') { exists = false; missing = parts.slice(index); break; }
        return { error: true };
      }
    }
    const resolvedBase = realpathSync(existing);
    return {
      exists,
      hasSymlink,
      resolvedPath: exists ? realpathSync(absolute) : path.join(resolvedBase, ...missing)
    };
  } catch {
    return { error: true };
  }
}

// One glob component as a regular expression: `*`, `?`, and `[...]` (with `!` or `^` for negation)
// match within the component. Returns null when the component has no glob character.
function globComponentPattern(component) {
  if (!/[*?[]/.test(component)) return null;
  let source = '';
  for (let index = 0; index < component.length; index += 1) {
    const character = component[index];
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '[' && component.indexOf(']', index + 2) > 0) {
      const close = component.indexOf(']', index + 2);
      let body = component.slice(index + 1, close);
      const negate = body[0] === '!' || body[0] === '^';
      if (negate) body = body.slice(1);
      source += `[${negate ? '^' : ''}${body.replace(/[\\\]^[]/g, '\\$&')}]`;
      index = close;
    } else source += character.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  try { return new RegExp(`^${source}$`); } catch { return undefined; }
}

// Expands a glob as bash does by default: components match one directory level, a leading dot must
// be written, and a pattern without matches expands to nothing here (the shell then passes the
// pattern itself, which names no existing file). `**` is refused because zsh reads it recursively.
export function expandGlob(pattern, cwd) {
  if (pattern.includes('**')) return { error: true };
  const absolute = absoluteCandidate(pattern, cwd);
  const root = path.parse(absolute).root;
  let current = [root];
  let visited = 0;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    const expression = globComponentPattern(part);
    if (expression === undefined) return { error: true };
    const next = [];
    for (const directory of current) {
      if (!expression) {
        const candidate = path.join(directory, part);
        try { lstatSync(candidate); next.push(candidate); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) return { error: true }; }
        continue;
      }
      let names;
      try { names = readdirSync(directory); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error?.code)) continue; return { error: true }; }
      for (const name of names) {
        visited += 1;
        if (visited > MAX_RECURSIVE_ENTRIES) return { error: true };
        if (name.startsWith('.') && !part.startsWith('.')) continue;
        if (expression.test(name)) next.push(path.join(directory, name));
      }
    }
    if (next.length > MAX_GLOB_MATCHES) return { error: true };
    current = next;
  }
  return { paths: current.sort() };
}

function pathFact(candidate, cwd) {
  const fact = inspectPath(candidate.value, cwd);
  if (!candidate.recursive || fact.error || !fact.exists) return fact;
  let metadata;
  try { metadata = statSync(fact.resolvedPath); } catch { return { error: true }; }
  if (!metadata.isDirectory()) return fact;
  const visible = candidate.recursive.respectsGitignore ? gitVisibleHoldsSensitive(fact.resolvedPath, candidate.recursive) : null;
  return { ...fact, recursive: visible ?? directoryHoldsSensitive(fact.resolvedPath, candidate.recursive) };
}

export function collectRuntimeContext(input) {
  const analysis = collectCandidates(input);
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  return {
    pathFacts: analysis.candidates.map((candidate) => {
      if (candidate.dynamic || candidate.placeholder) return null;
      const relative = !path.isAbsolute(candidate.value) && !candidate.value.startsWith('~');
      const unknown = candidate.directory === UNKNOWN_DIRECTORY;
      const base = candidate.directory && !unknown ? absoluteCandidate(candidate.directory, cwd) : cwd;
      // After a directory change that cannot be followed, a relative glob or walk has no known base.
      if (unknown && relative && (candidate.glob || candidate.recursive)) return { error: true };
      if (!candidate.glob) return pathFact(candidate, base);
      const expanded = expandGlob(candidate.value, base);
      if (expanded.error) return expanded;
      if (expanded.paths.length > MAX_PATHS && candidate.recursive) return { error: true };
      return { glob: expanded.paths.map((value) => ({ value, fact: pathFact({ ...candidate, value, glob: false }, base) })) };
    })
  };
}

function pathFinding(value, fact) {
  if (isSensitivePath(value)) return blocked('sensitive-path-access', 'the operation targets a high-confidence credential or secret file');
  if (fact?.error) return blocked('sensitive-path-uninspectable', 'filesystem alias metadata cannot be inspected safely');
  if (fact?.resolvedPath && isSensitivePath(fact.resolvedPath)) {
    return blocked('sensitive-path-alias', 'a filesystem alias resolves to a high-confidence credential or secret file');
  }
  if (fact?.recursive?.error) return blocked('sensitive-path-uninspectable', 'a recursive file operation covers more entries than the bounded analyzer can verify');
  if (fact?.recursive?.sensitive) {
    return blocked('sensitive-path-recursive', 'a recursive file operation would include a high-confidence credential or secret file; exclude it or narrow the path');
  }
  return null;
}

export function evaluate(input, context = {}) {
  const analysis = collectCandidates(input);
  if (analysis.invalid) return blocked('sensitive-input-invalid', 'structured input or command syntax is invalid or exceeds a fixed analysis limit');
  if (!analysis.relevant) return allowed();
  if (analysis.tooMany) return blocked('sensitive-path-uninspectable', 'the operation addresses more paths than the bounded analyzer can verify');
  if (analysis.ambiguous) return blocked('sensitive-path-uninspectable', 'the file-access command uses a dynamic executable, a nested command envelope, or words supplied at run time');
  const facts = Array.isArray(context.pathFacts) ? context.pathFacts : [];
  for (let index = 0; index < analysis.candidates.length; index += 1) {
    const candidate = analysis.candidates[index];
    if (candidate.dynamic) return blocked('sensitive-path-uninspectable', 'a protected file-access boundary uses a dynamic path');
    if (typeof candidate.value !== 'string' || candidate.value.includes('\0')
      || Buffer.byteLength(candidate.value, 'utf8') > MAX_PATH_BYTES) {
      return blocked('sensitive-path-uninspectable', 'a protected path is invalid or exceeds a fixed analysis limit');
    }
    const fact = facts[index];
    if (candidate.glob) {
      // Without the expansion the glob could name any file, so it fails closed.
      if (!Array.isArray(fact?.glob)) return blocked('sensitive-path-uninspectable', 'a file glob could not be expanded within the analysis bounds');
      for (const match of fact.glob) {
        const finding = pathFinding(match.value, match.fact);
        if (finding) return finding;
      }
      continue;
    }
    const finding = pathFinding(candidate.value, fact);
    if (finding) return finding;
  }
  return allowed();
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error('input limit exceeded');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new Error('input is not valid JSON'); }
}

async function main() {
  let result;
  try {
    const input = await readInput();
    result = evaluate(input, collectRuntimeContext(input));
  } catch {
    result = blocked('sensitive-input-invalid', 'structured hook input is invalid or exceeds a fixed limit');
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
