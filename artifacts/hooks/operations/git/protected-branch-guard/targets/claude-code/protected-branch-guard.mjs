#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
// ends the segment: `&&`, `||`, `;`, `|`, `&`, `\n`, `(`, `)`, or '' at the end. Redirections, in any
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
      // A file descriptor number written right before the operator belongs to it (`0<<EOF`).
      if (token && !token.quoted && !token.dynamic && /^\d+$/.test(token.value)) { operator = token.value + operator; token = null; }
      pushToken();
      if (redirect) return { error: 'redirection without target' };
      redirections.push({ operator, target: { value: heredoc.delimiter, dynamic: false, heredoc } });
      // The body of an unquoted delimiter is attached to this segment when it is read.
      heredoc.owner = substitutions;
      heredocs.push(heredoc);
      index = heredoc.end - 1;
    } else if (character === '<' || character === '>' || (character === '&' && source[index + 1] === '>')) {
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
        for (const { operator, target } of redirections) {
          const input = /^(\d*)(<<-?|<<<|<>|<&|<)$/.exec(operator);
          if (!input) continue;
          const stdinFeed = input[1] === '' || input[1] === '0';
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
    let entries = unwrapCommand(segment.tokens, depth, wrappers, options, segment.redirections);
    if (options.redirections && segment.redirections.length) {
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
export const MAX_COMMAND_BYTES = SHELL_MAX_COMMAND_BYTES;
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
export const GIT_TIMEOUT_MS = 3000;
// All Git subprocesses share one budget below the 10 s adapter timeout: a timed-out hook does not block.
export const GIT_BUDGET_MS = 8000;
// Stands for a HEAD the parser cannot name. It is not a valid ref name, so it never matches a real branch.
const UNKNOWN_HEAD = '\0unknown-head';
const NATIVE_MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const HISTORY_MUTATIONS = new Set(['commit', 'merge', 'rebase', 'reset', 'cherry-pick', 'revert', 'am']);
const RECOVERY_FLAGS = new Set(['--abort', '--quit']);
function toolName(input) {
  const value = input?.tool_name ?? input?.toolName;
  return typeof value === 'string' ? value : '';
}
function toolPayload(input) {
  const value = input?.tool_input ?? input?.toolInput;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function commandFrom(input) {
  const value = toolPayload(input)?.command;
  return typeof value === 'string' ? value : '';
}
const SAFE_GIT_GLOBALS = new Set(['--no-pager', '--paginate', '--no-replace-objects', '--literal-pathspecs', '--no-optional-locks']);
const executable = executableName;

// Compatibility view for callers of the former local lexer: the static token lists of the commands,
// or an error when any command is ambiguous.
export function normalizeShell(command) {
  const parsed = parseShellCommands(command);
  if (parsed.error) return { error: parsed.error, invocations: [] };
  if (parsed.commands.some((entry) => entry.ambiguous)) return { error: 'command envelope is ambiguous', invocations: [] };
  return { invocations: parsed.commands.map((entry) => entry.tokens) };
}

// A value that xargs or find supplies at run time is as unknown as a shell expansion.
const unknownValue = (token) => (token.placeholder ? { value: token.value, dynamic: true } : token);

// Git global options other than a few display switches change the repository, configuration, or
// command the guard would inspect, so they make the invocation ambiguous.
function parseGitInvocation(tokens) {
  if (!tokens.length || executable(tokens[0]) !== 'git') return null;
  const invocation = gitInvocation(tokens);
  if (invocation.ambiguous) return { ambiguous: true };
  const globals = tokens.slice(1, invocation.name ? invocation.index : tokens.length);
  if (globals.some((token) => !SAFE_GIT_GLOBALS.has(token.value))) return { ambiguous: true };
  if (!invocation.name) return { subcommand: '', args: [] };
  return { subcommand: invocation.name, args: invocation.args.map(unknownValue) };
}
function normalizedBranch(value, currentBranch = null) {
  let ref = value.replace(/^\+/, '');
  if (ref === 'HEAD' || ref === '@') return currentBranch;
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('heads/')) return ref.slice('heads/'.length);
  if (/^(?:refs\/)?tags\//.test(ref) || ref.startsWith('refs/remotes/')) return null;
  return ref;
}
function protectedBranches(context) {
  const values = new Set(['main', 'master']);
  if (typeof context.defaultBranch === 'string' && context.defaultBranch) values.add(context.defaultBranch);
  if (context.currentBranch === UNKNOWN_HEAD) values.add(UNKNOWN_HEAD);
  return values;
}
function isProtected(value, context) {
  const branch = normalizedBranch(value, context.currentBranch);
  return typeof branch === 'string' && protectedBranches(context).has(branch);
}
function block(ruleId, reason) {
  return {
    exitCode: 2,
    ruleId,
    message: `BLOCKED by protected-branch-guard [${ruleId}]: ${reason}. Move the work to an unprotected branch or ask the user to perform the reviewed integration action.`
  };
}
function inspectBranchMutation(args, context) {
  let mode = null;
  const operands = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.dynamic) return mode ? block('protected-git-command-uninspectable', 'a protected branch target is dynamic') : null;
    const value = token.value;
    if (value === '--') { operands.push(...args.slice(index + 1).map((entry) => entry.value)); break; }
    if (value === '-d' || value === '-D' || value === '--delete') { mode = 'delete'; continue; }
    if (value.startsWith('--delete=')) { mode = 'delete'; operands.push(value.slice('--delete='.length)); continue; }
    if (['-f', '--force'].includes(value)) { mode = 'update'; continue; }
    if (['-m', '-M', '-c', '-C', '--move', '--copy'].includes(value)) { mode = 'rename'; continue; }
    if (/^-[A-Za-z]*[dD][A-Za-z]*$/.test(value)) { mode = 'delete'; continue; }
    if (!value.startsWith('-')) operands.push(value);
  }
  if (!mode) return null;
  if (args.some((entry) => entry.dynamic)) return block('protected-git-command-uninspectable', 'a protected branch target is dynamic');
  return operands.some((value) => isProtected(value, context))
    ? block(mode === 'delete' ? 'protected-branch-delete' : 'protected-branch-update', 'the command mutates a protected local branch reference')
    : null;
}
function inspectUpdateRef(args, context) {
  const operands = []; let deleting = false;
  for (const token of args) {
    if (token.dynamic) return block('protected-git-command-uninspectable', 'an update-ref target is dynamic');
    if (token.value === '-d' || token.value === '--delete') deleting = true;
    if (!token.value.startsWith('-')) operands.push(token.value);
  }
  const target = operands[0];
  return target && (isProtected(target, context) || /^(?:refs\/)?remotes\/origin\/HEAD$/i.test(target))
    ? block(deleting ? 'protected-branch-delete' : 'protected-branch-update', 'the command mutates a protected branch or default-branch authority')
    : null;
}
function inspectBranchCreation(args, context) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.dynamic) return block('protected-git-command-uninspectable', 'a branch creation target is dynamic');
    const match = /^(?:-B|-b|-C|-c)(.*)$/.exec(token.value);
    if (!match) continue;
    const target = match[1] || args[index + 1]?.value;
    if (!target || args[index + 1]?.dynamic) return block('protected-git-command-uninspectable', 'a branch creation target is not static');
    if (isProtected(target, context)) return block('protected-branch-update', 'the command creates or resets a protected branch');
  }
  return null;
}
function inspectPush(args, context) {
  let deleting = false;
  let dryRun = false;
  let fanout = false;
  let remoteFromOption = false;
  const operands = [];
  const valueOptions = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o']);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.dynamic) return block('protected-git-command-uninspectable', 'a push destination is dynamic');
    const value = token.value;
    if (value === '--') {
      for (const rest of args.slice(index + 1)) {
        if (rest.dynamic) return block('protected-git-command-uninspectable', 'a push destination is dynamic');
        operands.push(rest.value);
      }
      break;
    }
    if (value === '--dry-run' || value === '-n') { dryRun = true; continue; }
    if (value === '--delete' || value === '-d') { deleting = true; continue; }
    if (value.startsWith('--delete=')) { deleting = true; operands.push(value.slice('--delete='.length)); continue; }
    if (value === '--all' || value === '--mirror') { fanout = true; continue; }
    if (valueOptions.has(value)) {
      const next = args[index + 1];
      if (!next || next.dynamic) return block('protected-git-command-uninspectable', 'a push option value is not static');
      if (value === '--repo') remoteFromOption = true;
      index += 1;
      continue;
    }
    if (/^--(?:repo|receive-pack|exec|push-option)=/.test(value)) {
      if (value.startsWith('--repo=')) remoteFromOption = true;
      continue;
    }
    if (/^(?:-u|--set-upstream|--porcelain|--atomic|--follow-tags|--no-verify|--signed(?:=.+)?|--force(?:-with-lease(?:=.+)?)?|--force-if-includes|--verbose|-v|--quiet|-q|--progress|--no-progress|--ipv4|-4|--ipv6|-6)$/.test(value)) continue;
    if (value.startsWith('-')) return block('protected-git-command-uninspectable', 'a push option cannot be classified without guessing');
    operands.push(value);
  }
  if (dryRun) return null;
  if (context.inspectionError) return block('protected-branch-unverified', 'repository branch state cannot be inspected safely');
  if (fanout) return block('protected-branch-direct-push', 'a fan-out push can update a protected branch');
  const remote = remoteFromOption ? null : (operands[0] ?? null);
  const refspecs = remoteFromOption ? operands : operands.slice(1);
  if (refspecs.length === 0) {
    if (context.pushBranch && (remote === null || remote === context.pushRemote)) {
      return isProtected(context.pushBranch, context)
        ? block('protected-branch-direct-push', 'the configured push destination is a protected branch')
        : null;
    }
    const rule = context.currentBranch && protectedBranches(context).has(context.currentBranch)
      ? 'protected-branch-direct-push' : 'protected-git-command-uninspectable';
    return block(rule, 'the configured upstream push destination cannot be verified statically');
  }
  const mapped = remote === null ? (context.pushConfiguredRemotes?.size ?? 0) > 0 : Boolean(context.pushConfiguredRemotes?.has(remote));
  for (const refspec of refspecs) {
    if (/[*?[]/.test(refspec)) return block('protected-git-command-uninspectable', 'a wildcard refspec can include a protected branch');
    const separator = refspec.lastIndexOf(':');
    if (separator < 0 && mapped) {
      return block('protected-git-command-uninspectable', 'the remote has a configured push mapping that can redirect this refspec');
    }
    const destination = separator >= 0 ? refspec.slice(separator + 1) : refspec;
    if (!destination) return block('protected-git-command-uninspectable', 'a push destination is empty or ambiguous');
    if (isProtected(destination, context)) {
      return block(deleting || refspec.startsWith(':') ? 'protected-branch-delete' : 'protected-branch-direct-push', deleting || refspec.startsWith(':')
        ? 'the push deletes a protected remote branch'
        : 'the push writes directly to a protected remote branch');
    }
  }
  return null;
}
// `git fetch <remote> <src>:<dst>` writes <dst> locally; `git pull <remote> <src>` also merges <src>
// into the current branch. Refreshing a protected branch from the same-named branch of a named
// remote is a sync, not an integration, so it stays allowed. Bare fetch and pull use configured refspecs.
function inspectFetch(args, context, pulling) {
  const operands = [];
  let multiple = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.dynamic) return block('protected-git-command-uninspectable', 'a fetch or pull refspec is dynamic');
    const value = token.value;
    if (value === '--') { operands.push(...args.slice(index + 1).map((entry) => entry.value)); break; }
    if (value === '--refmap' || value.startsWith('--refmap=')) return block('protected-git-command-uninspectable', 'a fetch refmap can redirect a refspec to a protected branch');
    if (value === '--all' || value === '--multiple') multiple = true;
    if (/^(?:--depth|--deepen|--shallow-since|--shallow-exclude|-j|--jobs|--upload-pack|-o|--server-option|--negotiation-tip|-s|--strategy|-X|--strategy-option)$/.test(value)) { index += 1; continue; }
    if (!value.startsWith('-')) operands.push(value);
  }
  const [remote, ...refspecs] = operands;
  if (multiple || refspecs.length === 0) return null;
  if (pulling && context.inspectionError) return block('protected-branch-unverified', 'repository branch state cannot be inspected safely');
  const named = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(remote);
  for (const refspec of refspecs) {
    const separator = refspec.lastIndexOf(':');
    const source = normalizedBranch(separator < 0 ? refspec : refspec.slice(0, separator), context.currentBranch);
    const destination = separator < 0 ? '' : refspec.slice(separator + 1);
    if (/[*?[]/.test(destination) && !/^(?:refs\/)?(?:remotes|tags)\//.test(destination)) {
      return block('protected-git-command-uninspectable', 'a wildcard fetch destination can include a protected branch');
    }
    if (destination && isProtected(destination, context) && !(named && source === normalizedBranch(destination, context.currentBranch))) {
      return block('protected-branch-update', 'the fetch writes another branch into a protected local branch');
    }
    if (pulling && context.currentBranch && protectedBranches(context).has(context.currentBranch) && !(named && source === context.currentBranch)) {
      return block('protected-branch-history-mutation', 'the pull integrates another branch into the current protected branch');
    }
  }
  return null;
}

// Returns where HEAD may point after the invocation: a branch name, null for a detached HEAD,
// UNKNOWN_HEAD when it cannot be named statically, or undefined when HEAD keeps its branch.
// `git reset`, `git branch -f`, `git worktree add`, and `git bisect` do not move HEAD to another
// branch of this worktree (reset moves the current branch itself; bisect only detaches), so the
// destination of a later push is unchanged.
function headAfter(parsed) {
  const { subcommand, args } = parsed;
  const nameOf = (token) => (!token ? undefined : token.dynamic || token.value === '-' || token.value.includes('@{') ? UNKNOWN_HEAD : token.value);
  if (subcommand === 'checkout' || subcommand === 'switch') {
    const operands = [];
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index];
      if (token.dynamic) { operands.push(token); continue; }
      const value = token.value;
      const create = /^(?:-b|-B|-c|-C|--orphan|--create|--force-create)$/.test(value) ? [value, null] : /^-[bBcC](.+)$/.exec(value);
      if (create && !(subcommand === 'checkout' ? /^-[cC]/.test(value) : /^-[bB]/.test(value))) {
        return nameOf(create[1] === null ? args[index + 1] : { value: create[1] });
      }
      if (value === '--') return undefined;
      if (/^(?:-p|--patch|--ours|--theirs|--pathspec-from-file(?:=.*)?)$/.test(value)) return undefined;
      if (/^(?:-d|--detach)$/.test(value)) return null;
      if (/^(?:-t|--track(?:=.*)?)$/.test(value)) return UNKNOWN_HEAD;
      if (value === '-' || !value.startsWith('-')) operands.push(token);
    }
    if (operands.length === 0 || (subcommand === 'checkout' && operands.length > 1)) return undefined;
    return nameOf(operands[0]);
  }
  if (subcommand === 'rebase') {
    const operands = [];
    for (let index = 0; index < args.length; index += 1) {
      if (/^(?:--onto|-s|--strategy|-X|--strategy-option|-x|--exec|-C)$/.test(args[index].value)) { index += 1; continue; }
      if (args[index].dynamic || args[index].value === '-' || !args[index].value.startsWith('-')) operands.push(args[index]);
    }
    return nameOf(args.some((token) => token.value === '--root') ? operands[0] : operands[1]);
  }
  if (subcommand === 'branch' && args.some((token) => /^(?:-m|-M|--move)$/.test(token.value))) {
    return nameOf(args.filter((token) => token.dynamic || !token.value.startsWith('-')).at(-1));
  }
  if (subcommand === 'symbolic-ref') {
    const operands = args.filter((token) => token.dynamic || !token.value.startsWith('-'));
    if (operands[0]?.value !== 'HEAD' || operands[0].dynamic) return operands[0]?.dynamic ? UNKNOWN_HEAD : undefined;
    if (args.some((token) => token.value === '-d' || token.value === '--delete')) return UNKNOWN_HEAD;
    if (!operands[1]) return undefined;
    return operands[1].dynamic ? UNKNOWN_HEAD : normalizedBranch(operands[1].value) ?? null;
  }
  return undefined;
}

// Applies a `git config` write to the aliases and push mappings seen by later invocations.
// Returns 'read', 'write', or 'dynamic'.
function applyConfig(args, aliases, pushConfiguredRemotes) {
  const operands = [];
  let unset = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].dynamic) return 'dynamic';
    const value = args[index].value;
    if (/^(?:-l|--list|--get(?:-all|-regexp|-urlmatch|-color|colorbool)?|get|list)$/.test(value)) return 'read';
    if (/^(?:--unset(?:-all)?|unset)$/.test(value)) { unset = true; continue; }
    if (/^(?:-f|--file|--blob|--type|--default|--comment|--value)$/.test(value)) { index += 1; continue; }
    if (!value.startsWith('-') && value !== 'set') operands.push(value);
  }
  const [key, value] = operands;
  if (!key || (!unset && operands.length < 2)) return 'read';
  const name = key.toLowerCase();
  if (name.startsWith('alias.')) {
    if (unset) aliases.delete(name.slice('alias.'.length));
    else aliases.set(name.slice('alias.'.length), value);
  } else if (/^remote\..+\.push$/.test(name)) pushConfiguredRemotes.add(key.slice('remote.'.length, -'.push'.length));
  return 'write';
}

const RELEVANT_SUBCOMMANDS = new Set(['push', 'send-pack', 'http-push', 'branch', 'update-ref', 'checkout', 'switch', 'symbolic-ref', 'remote', ...HISTORY_MUTATIONS]);
const RUNNER_SUBCOMMANDS = new Set([...RELEVANT_SUBCOMMANDS, 'pull', 'fetch']);
// find stays listed: an -exec without its terminator is not unwrapped, and the guard still refuses it.
const COMMAND_RUNNERS = new Set(['find', 'parallel', 'watch']);
const RUNNER_WRAPPERS = new Set(['xargs', 'find']);
const SEQUENCE_REASON = 'an earlier command in the same shell command changes the branch, HEAD, or Git configuration this command depends on';
// Read-only built-ins still allowed when repository state (and so the alias table) cannot be read.
// Git never runs an alias named like a built-in, so these names cannot hide one.
const READ_ONLY_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'describe', 'shortlog', 'cat-file', 'help', 'version']);

// Git runs an alias only when no built-in command has that name, so a configured alias is
// expanded once and re-inspected. Shell aliases (`!…`) and aliases of aliases are not expanded.
function expandAlias(parsed, context, depth = 0) {
  const alias = context.aliases?.get(parsed.subcommand);
  if (alias === undefined) return parsed;
  if (depth > 0 || alias.trimStart().startsWith('!')) return { ambiguous: true };
  const normalized = parseShellCommands(`git ${alias}`);
  if (normalized.error || normalized.commands.length !== 1 || !normalized.commands[0].tokens) return { ambiguous: true };
  const expanded = parseGitInvocation([...normalized.commands[0].tokens, ...parsed.args]);
  if (!expanded || expanded.ambiguous) return { ambiguous: true };
  return expandAlias(expanded, context, depth + 1);
}

function inspectGit(parsed, context) {
  if (!parsed || !parsed.subcommand) return null;
  if (parsed.ambiguous) return block('protected-git-command-uninspectable', 'the Git invocation cannot be normalized safely');
  if (parsed.subcommand === 'send-pack' || parsed.subcommand === 'http-push') {
    return block('protected-git-command-uninspectable', 'a low-level push command can update a protected branch');
  }
  if (parsed.subcommand === 'push') return inspectPush(parsed.args, context);
  if (parsed.subcommand === 'fetch' || parsed.subcommand === 'pull') return inspectFetch(parsed.args, context, parsed.subcommand === 'pull');
  if (parsed.subcommand === 'worktree' && parsed.args[0]?.value === 'add') return inspectBranchCreation(parsed.args.slice(1), context);
  if (parsed.subcommand === 'branch') return inspectBranchMutation(parsed.args, context);
  if (parsed.subcommand === 'update-ref') return inspectUpdateRef(parsed.args, context);
  if (parsed.subcommand === 'checkout' || parsed.subcommand === 'switch') return inspectBranchCreation(parsed.args, context);
  if (parsed.subcommand === 'symbolic-ref' && parsed.args.some((token) => /^(?:refs\/)?(?:heads\/(?:main|master)|remotes\/origin\/HEAD)$/i.test(token.value))) {
    return block('protected-branch-update', 'the command mutates a protected branch or default-branch authority');
  }
  if (parsed.subcommand === 'remote' && parsed.args[0]?.value === 'set-head') {
    return block('protected-branch-update', 'the command mutates the locally discovered default-branch authority');
  }
  if (!HISTORY_MUTATIONS.has(parsed.subcommand)) return null;
  if (parsed.args.some((token) => RECOVERY_FLAGS.has(token.value))) return null;
  if (context.inspectionError) return block('protected-branch-unverified', 'repository branch state cannot be inspected safely');
  if (context.currentBranch && protectedBranches(context).has(context.currentBranch)) {
    return block('protected-branch-history-mutation', 'the Git command changes history on the current protected branch');
  }
  return null;
}
export function evaluate(input, context = {}) {
  const name = toolName(input);
  if (NATIVE_MUTATION_TOOLS.has(name)) {
    if (context.inspectionError) return block('protected-branch-unverified', 'repository branch state cannot be inspected safely');
    if (context.repo && context.currentBranch && protectedBranches(context).has(context.currentBranch)) {
      return block('protected-branch-native-mutation', 'a native file mutation would occur on the current protected branch');
    }
    return { exitCode: 0, message: '', ruleId: null };
  }
  if (name !== 'Bash') return { exitCode: 0, message: '', ruleId: null };
  const command = commandFrom(input);
  if (!command) return { exitCode: 0, message: '', ruleId: null };
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    return block('protected-command-too-large', 'the shell command exceeds the analysis limit');
  }
  const normalized = parseShellCommands(command);
  if (normalized.error || normalized.commands.some((entry) => entry.ambiguous)) {
    return block('protected-command-uninspectable', 'the shell envelope cannot be normalized safely');
  }
  // Context describes the repository before the command runs. An earlier invocation can change the
  // current branch, so every Git invocation is checked against each branch HEAD may be on by then.
  // After `git switch <branch> &&`, the rest of the `&&` chain (and pipelines inside it) runs only
  // if the switch succeeded, so HEAD is known to be <branch> there; after `;`, `||`, `&`, or a
  // newline, the original branch stays a candidate because a failed switch leaves HEAD on it.
  // A bare push uses the `@{push}` resolved before the command, only until a config change.
  const heads = [context.currentBranch ?? null];
  let certain;
  const aliases = new Map(context.aliases ?? []);
  const pushConfiguredRemotes = new Set(context.pushConfiguredRemotes ?? []);
  let pushStale = false;
  let configUnknown = false;
  const pushTarget = (branch) => {
    if (pushStale) return {};
    if (branch === (context.currentBranch ?? null)) return { pushBranch: context.pushBranch, pushRemote: context.pushRemote };
    const known = typeof branch === 'string' ? context.pushByBranch?.get?.(branch) : undefined;
    return known ? { pushBranch: known.branch, pushRemote: known.remote } : {};
  };
  const moveHead = (head, operator) => {
    if (head === undefined) {
      if (operator !== '&&' && operator !== '|') certain = undefined;
      return;
    }
    if (!heads.includes(head)) heads.push(head);
    certain = operator === '&&' ? head : undefined;
  };
  for (const entry of normalized.commands) {
    const invocation = entry.tokens;
    const name = executable(invocation[0]);
    const scopeChanged = entry.changedDirectory;
    if (['cd', 'pushd', 'popd'].includes(name)) { moveHead(undefined, entry.operator); continue; }
    if (name === 'gh' && invocation[1]?.value === 'pr' && invocation[2]?.value === 'checkout') {
      moveHead(UNKNOWN_HEAD, entry.operator);
      continue;
    }
    if (COMMAND_RUNNERS.has(name)) {
      const gitIndex = invocation.findIndex((token) => executable(token) === 'git');
      if (gitIndex >= 0) {
        const next = invocation.slice(gitIndex + 1).find((token) => !token.value.startsWith('-'));
        if (!next || next.dynamic || RUNNER_SUBCOMMANDS.has(next.value.toLowerCase())) {
          return block('protected-command-uninspectable', 'a command runner can start a Git mutation with arguments the guard cannot see');
        }
      }
      moveHead(undefined, entry.operator);
      continue;
    }
    // The commands of `$(…)` and backtick substitutions come before this entry and are judged on their own.
    const raw = parseGitInvocation(invocation);
    if (!raw) { moveHead(undefined, entry.operator); continue; }
    if (entry.wrappers.some((wrapper) => RUNNER_WRAPPERS.has(wrapper))
      && (raw.ambiguous || !raw.subcommand || RUNNER_SUBCOMMANDS.has(raw.subcommand))) {
      return block('protected-command-uninspectable', 'a command runner can start a Git mutation with arguments the guard cannot see');
    }
    if (configUnknown && raw.subcommand) return block('protected-git-sequence-uninspectable', SEQUENCE_REASON);
    // Without the alias table any other name may be an alias for a protected push.
    if (context.inspectionError && raw.subcommand && !READ_ONLY_SUBCOMMANDS.has(raw.subcommand)) {
      return block('protected-branch-unverified', 'repository branch state cannot be inspected safely');
    }
    const local = { ...context, aliases, pushConfiguredRemotes };
    const parsed = raw.ambiguous ? raw : expandAlias(raw, local);
    if (parsed.ambiguous) return block('protected-git-command-uninspectable', 'the Git invocation changes or obscures repository scope');
    const relevant = RELEVANT_SUBCOMMANDS.has(parsed.subcommand);
    if (scopeChanged && relevant) return block('protected-git-scope-uninspectable', 'a shell directory change prevents reliable repository inspection');
    if (scopeChanged && ['pull', 'fetch'].includes(parsed.subcommand)
      && inspectGit(parsed, { ...local, currentBranch: UNKNOWN_HEAD, defaultBranch: null })) {
      return block('protected-git-scope-uninspectable', 'a shell directory change prevents reliable repository inspection');
    }
    // `git rebase <upstream> <branch>` switches to <branch> before rewriting it.
    const head = headAfter(parsed);
    const candidates = certain !== undefined ? [certain] : [...heads];
    if (parsed.subcommand === 'rebase' && head !== undefined && !candidates.includes(head)) candidates.push(head);
    for (const current of candidates) {
      const original = current === (context.currentBranch ?? null) && !pushStale;
      const decision = inspectGit(parsed, { ...local, currentBranch: current, pushBranch: null, pushRemote: null, ...pushTarget(current) });
      if (!decision) continue;
      // A block that only an earlier branch or config change produces, and that does not name a
      // protected target, is caused by that change.
      if (original || (current !== UNKNOWN_HEAD && !/uninspectable$/.test(decision.ruleId))) return decision;
      return block('protected-git-sequence-uninspectable', SEQUENCE_REASON);
    }
    moveHead(head, entry.operator);
    if (parsed.subcommand === 'config') {
      const effect = applyConfig(parsed.args, aliases, pushConfiguredRemotes);
      if (effect !== 'read') pushStale = true;
      if (effect === 'dynamic') configUnknown = true;
    }
    if (parsed.subcommand === 'branch' && parsed.args.some((token) => /^(?:-u|--set-upstream-to(?:=.*)?|--unset-upstream)$/.test(token.value) || /^-u./.test(token.value))) pushStale = true;
  }
  return { exitCode: 0, message: '', ruleId: null };
}
function cleanGitEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}
function runGit(root, args, options) {
  if (typeof options.runGit === 'function') return options.runGit(root, args, options);
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: options.timeout ?? GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
    env: { ...cleanGitEnvironment(options.env ?? process.env), LC_ALL: 'C', LANG: 'C' }
  });
}
function commandResult(result) {
  if (result?.error) return { error: true };
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  if (Buffer.byteLength(stdout, 'utf8') > MAX_GIT_OUTPUT_BYTES || Buffer.byteLength(stderr, 'utf8') > MAX_GIT_OUTPUT_BYTES) return { error: true };
  return { status: result?.status, stdout: stdout.trim(), stderr: stderr.trim() };
}
const MAX_SWITCH_TARGETS = 4;
// Static branch names that `git switch`/`git checkout` in the command move HEAD to.
function switchTargets(command, currentBranch) {
  const targets = [];
  const parsed = parseShellCommands(command);
  for (const entry of parsed.error ? [] : parsed.commands) {
    const git = entry.tokens ? parseGitInvocation(entry.tokens) : null;
    if (!git || git.ambiguous || !['switch', 'checkout'].includes(git.subcommand)) continue;
    const head = headAfter(git);
    if (typeof head === 'string' && head !== UNKNOWN_HEAD && head !== currentBranch && /^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/.test(head) && !targets.includes(head)) targets.push(head);
    if (targets.length >= MAX_SWITCH_TARGETS) break;
  }
  return targets;
}
export function collectContext(input, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.env ?? process.env;
  const supplied = environment.CLAUDE_PROJECT_DIR ?? input?.cwd ?? cwd;
  if (typeof supplied !== 'string' || supplied.length === 0 || /[\0\r\n]/.test(supplied) || Buffer.byteLength(supplied, 'utf8') > 16 * 1024) {
    return { repo: false, inspectionError: true };
  }
  const root = path.resolve(cwd, supplied);
  const deadline = Date.now() + GIT_BUDGET_MS;
  const git = (args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { error: true };
    return commandResult(runGit(root, args, { ...options, env: environment, timeout: Math.min(GIT_TIMEOUT_MS, remaining) }));
  };
  const gitDir = git(['rev-parse', '--git-dir']);
  if (gitDir.error) return { repo: false, inspectionError: true };
  if (gitDir.status !== 0) {
    return /not a git repository|not a git work tree/i.test(gitDir.stderr)
      ? { repo: false, inspectionError: false, currentBranch: null, defaultBranch: null }
      : { repo: false, inspectionError: true };
  }
  const current = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (current.error) return { repo: true, inspectionError: true };
  let currentBranch = null;
  let detached = false;
  if (current.status === 0 && current.stdout) currentBranch = current.stdout;
  else if (current.status === 1) detached = true;
  else return { repo: true, inspectionError: true };
  const remoteHead = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead.error) return { repo: true, inspectionError: true };
  let defaultBranch = null;
  if (remoteHead.status === 0 && remoteHead.stdout.startsWith('origin/')) defaultBranch = remoteHead.stdout.slice('origin/'.length);
  else if (![1, 128].includes(remoteHead.status)) return { repo: true, inspectionError: true };

  const config = git(['config', '--get-regexp', '^(alias\\..*|remote\\..*\\.push)$']);
  if (config.error || ![0, 1].includes(config.status)) return { repo: true, inspectionError: true };
  const aliases = new Map();
  const pushConfiguredRemotes = new Set();
  for (const line of config.status === 0 ? config.stdout.split('\n') : []) {
    const separator = line.indexOf(' ');
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1);
    if (key.startsWith('alias.')) aliases.set(key.slice('alias.'.length).toLowerCase(), value);
    else if (/^remote\..+\.push$/.test(key)) pushConfiguredRemotes.add(key.slice('remote.'.length, -'.push'.length));
  }

  // `@{push}` is Git's own answer to "where would a bare `git push` write"; it honours push.default,
  // upstream, and remote.<name>.push, and fails when the answer is not a single destination.
  let pushRemote = null;
  let pushBranch = null;
  if (currentBranch) {
    const remoteName = git(['for-each-ref', '--format=%(push:remotename)', `refs/heads/${currentBranch}`]);
    const destination = git(['rev-parse', '--symbolic-full-name', '@{push}']);
    if (remoteName.error || destination.error) return { repo: true, inspectionError: true };
    const prefix = `refs/remotes/${remoteName.stdout}/`;
    if (remoteName.status === 0 && remoteName.stdout && destination.status === 0 && destination.stdout.startsWith(prefix)) {
      pushRemote = remoteName.stdout;
      pushBranch = destination.stdout.slice(prefix.length);
    }
  }

  // The same answer for branches the command switches to, so a push after `git switch <branch> &&`
  // can be judged. A branch Git cannot resolve simply has no entry.
  const pushByBranch = new Map();
  for (const branch of switchTargets(commandFrom(input), currentBranch)) {
    const remoteName = git(['for-each-ref', '--format=%(push:remotename)', `refs/heads/${branch}`]);
    const destination = git(['rev-parse', '--symbolic-full-name', `${branch}@{push}`]);
    const prefix = `refs/remotes/${remoteName.stdout}/`;
    if (!remoteName.error && !destination.error && remoteName.status === 0 && remoteName.stdout && destination.status === 0 && destination.stdout.startsWith(prefix)) {
      pushByBranch.set(branch, { remote: remoteName.stdout, branch: destination.stdout.slice(prefix.length) });
    }
  }

  return { repo: true, inspectionError: false, currentBranch, defaultBranch, detached, aliases, pushConfiguredRemotes, pushRemote, pushBranch, pushByBranch };
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
  } catch {
    throw new Error('hook input is not valid JSON');
  }
}
async function main() {
  let result;
  try {
    const input = await readInput();
    result = evaluate(input, collectContext(input));
  } catch (error) {
    result = block('protected-branch-input-invalid', error.message);
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
