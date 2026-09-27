#!/usr/bin/env node

import { realpathSync } from 'node:fs';
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
// Wrappers after which the shell still looks up its functions (`time f`, zsh `noglob f`); every other
// wrapper runs an external command or a builtin (`command f`, `sudo f`, `env f`), never a function.
const SHELL_FUNCTION_WRAPPERS = new Set(['time', 'noglob']);
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
    else if (character === '$' || character === '`' || ((character === '<' || character === '>') && source[index + 1] === '(')) {
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
// segment it came from, so a hook can still judge that segment's text. A function definition runs
// nothing: the commands of a `{ … }` body are kept aside and stand in for each later call of the name
// that looks up functions (bare, or after `!`, `time`, `noglob`, a reserved word; not after `command`,
// `builtin`, `exec`, `env`, `sudo`, or any other wrapper, where the name is an ordinary executable),
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
      if (entry.ambiguous) entry.segment ??= segment.tokens;
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
// <youdede:shared inline-script>
// Shell commands written inside an interpreter one-liner (shared block `inline-script`), such as
// `python3 -c "os.system('npm publish')"` or `cmd /c "sc stop x"`. scripts/generate-shared-hooks.mjs
// drops the import below and requires the `shell` block in the same hook. Edit it here and run
// `npm run shared-hooks`. Nothing is executed. A program that builds its command at run time, or passes
// it as an argument list, is not seen as a command; see `inlineShellCommands` for when it is ambiguous.

// Interpreter -> option that carries the inline program, as a separate word (`-c CODE`) or attached
// (`-cCODE`, `--eval=CODE`): group 1 is the attached program. Then whether the program runs to the end
// of the command line, and its language, which picks the literal and comment forms. Last, the option
// region: options end at `--` or at the first operand (the script, `-` for standard input, a module
// after `-m`/`-f`), and every later word belongs to that script (`node app.js --eval x` runs app.js).
// Any option may take the next word as its value (`node -r mod`, `node --inspect-publish-uid http`,
// `ruby -I dir`), and no hand-written list of such options stays complete, so the word after an option
// without `=` is read as its value, never as the script: a program option after it is still found
// (fail closed: `node --no-warnings app.js -e x` is read as a one-liner too). `stops` are options after
// which the rest belongs to a module or file; `continues` are subcommands whose own options follow
// (`deno repl --eval`). cmd
// programs are shell-like, so the whole program is read as a command too. PowerShell is unwrapped by
// the `shell` block itself.
const INLINE_PROGRAM_OPTIONS = [
  [/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/, /^-[bBdEhiIOPqsSuvVxR]*c(.*)$/s, false, 'python', { stops: /^-[bBdEhiIOPqsSuvVxR]*m/ }],
  [/^(?:node|nodejs|bun)(?:\.exe)?$/, /^(?:-(?:pe|ep|e|p)=?|--eval=|--eval$|--print=|--print$)(.*)$/s, false, 'js', {}],
  [/^deno(?:\.exe)?$/, /^(?:eval$|--eval$|--eval=)(.*)$/s, true, 'js', { continues: new Set(['repl']) }],
  [/^ruby(?:\.exe)?$/, /^-[acdlnpsSvwyU]*e(.*)$/s, false, 'ruby', {}],
  [/^perl(?:\.exe)?$/, /^-(?:[acfnpsStTuUvwWX]|l[0-7]*|0[0-7]*|0x[0-9A-Fa-f]*)*[eE](.*)$/s, false, 'perl', {}],
  [/^php(?:\.exe)?$/, /^(?:-[rBRE]|--(?:run|process-begin|process-code|process-end)(?:=|$))(.*)$/s, false, 'php',
    { stops: /^(?:-[fFS]|--(?:file|process-file|server))$/ }],
  [/^cmd(?:\.exe)?$/, /^\/[cCkKrR](.*)$/s, true, 'cmd', { option: /^\// }]
];
const INLINE_MAX_LITERALS = 256;
const INLINE_PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };
// A program is `capable` when its code (literal contents and comments removed) names something that
// can run a command in its language: a module, a call, an executing literal (backtick outside JS, `%x`,
// `qx`, whose opener stays in the code), or a dynamic name that can reach one. `open` counts only where
// it can open a pipe (Ruby `Kernel#open`, Perl); Python and JavaScript `open` is file I/O. A capable
// program is always ambiguous: the reader does not follow how it builds its command. Without any of
// these, the program's literals are data.
const INLINE_CAPABLE = {
  python: /\b(?:subprocess|pty|commands|system|popen\w*|spawn\w*|posix_spawn\w*|exec[lv]\w*|fork\w*|startfile|getattr|__import__|importlib|eval|exec|compile)\b/,
  js: /child_process|\b(?:execa|exec|execSync|execFile|execFileSync|spawn|spawnSync|fork|eval|require|Function)\b|\bimport\s*\(|\bprocess\s*\.\s*(?:binding|dlopen)\b|\bBun\s*\.\s*(?:spawn\w*|\$)|\$`|\bDeno\s*\.\s*(?:Command|run)\b/,
  ruby: /\b(?:system|exec|spawn|fork|syscall|open|popen\w*|Open3|PTY|Kernel|eval|instance_eval|class_eval|module_eval|send|public_send|__send__|method|constantize|const_get|require|load)\b|`|%x/,
  perl: /\b(?:system|exec|qx|open|readpipe|fork|eval|require)\b|IPC::|`/,
  php: /\b(?:exec|system|passthru|shell_exec|popen|proc_open|pcntl_exec|eval|assert|create_function|call_user_func\w*|include|require\w*)\b|`/
};
// A here-document, whatever its delimiter: Ruby and Perl `<<ID`, `<<~ID`, `<<-ID`, `<<"ID"`, `<< "ID"`,
// and PHP `<<<ID`. The reader does not follow its body, so a capable program holding one blocks.
const INLINE_HEREDOC = { ruby: /<<[~-]?\s*(?:[A-Za-z_]|["'`])/, perl: /<<~?\s*(?:[A-Za-z_]|["'`])/, php: /<<<\s*["']?[A-Za-z_]/ };
// Interpolation inside a literal is code: Ruby `#{…}`, JS `${…}`, Perl `@{[…]}`, PHP `{$…}`.
const INLINE_INTERPOLATION = /#\{|\$\{|@\{|\{\$/;

// The opening of a literal at `index`: the text that opens it, its delimiter, and whether running the
// program executes it as a command (backticks outside JS, Ruby `%x`, Perl `qx`). Quotes open a literal
// in every language, and Python triple quotes (`'''`, `"""`) take a three-character delimiter; Ruby adds
// `%q`/`%Q`/`%x` with any delimiter and `%(…)`-style bare forms, Perl adds `q`/`qq`/`qx`/`qw` with any
// delimiter, a word character too when whitespace separates it (`q XtextX`).
function literalOpening(program, index, language) {
  const character = program[index];
  const triple = character.repeat(3);
  // How the literal's escapes decode: `single` knows only the backslash and the delimiter (Ruby, Perl,
  // and PHP single quotes, `%q`, `q`, `qw`), `raw` none (Python raw strings, cmd).
  const interpreting = language === 'cmd' ? 'raw' : language;
  if (language === 'python' && (character === "'" || character === '"')) {
    const escapes = /[rR]/.test(/[A-Za-z]{0,2}$/.exec(program.slice(Math.max(0, index - 2), index))[0]) ? 'raw' : 'python';
    const delimiter = program.startsWith(triple, index) ? triple : character;
    return { opener: delimiter, delimiter, executes: false, escapes };
  }
  if (character === "'") return { opener: character, delimiter: character, executes: false, escapes: language === 'js' ? 'js' : interpreting === 'raw' ? 'raw' : 'single' };
  if (character === '"') return { opener: character, delimiter: character, executes: false, escapes: interpreting };
  if (character === '`') return { opener: '`', delimiter: '`', executes: language !== 'js', escapes: interpreting };
  const rest = program.slice(index, index + 8);
  if (language === 'ruby' && character === '%') {
    const match = /^%([qQx]?)([^\w\s])/.exec(rest);
    if (match && (match[1] || match[2] in INLINE_PAIRS)) return { opener: match[0], delimiter: match[2], executes: match[1] === 'x', escapes: match[1] === 'q' ? 'single' : 'ruby' };
  }
  if (language === 'perl' && character === 'q' && !/[\w$@%&>]/.test(program[index - 1] ?? '')) {
    const match = /^(qq|qx|qw|q)(?:([^\w\s=,;)])|\s+([^\s=,;)#]))/.exec(program.slice(index, index + 64));
    if (match) return { opener: match[0], delimiter: match[2] ?? match[3], executes: match[1] === 'qx', escapes: match[1] === 'q' || match[1] === 'qw' ? 'single' : 'perl' };
  }
  return null;
}

// Static escapes each language decodes in an interpolating literal. `unknown` lists the escapes the
// reader does not decode (`\\N{…}`, Perl case changes, Ruby control characters): a literal holding one
// has a value the reader does not know.
const INLINE_SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07', b: '\b', e: '\x1b', s: ' ' };
const INLINE_ESCAPES = {
  python: { simple: 'ntrfvab', hex: /^x([0-9A-Fa-f]{2})/, u4: true, u8: true, braces: null, unknown: /^[xuUN]/, keepOther: true },
  js: { simple: 'ntrfvb', hex: /^x([0-9A-Fa-f]{2})/, u4: true, u8: false, braces: /^u\{([0-9A-Fa-f]{1,6})\}/, unknown: /^[xu]/, keepOther: false },
  ruby: { simple: 'ntrfvabes', hex: /^x([0-9A-Fa-f]{1,2})/, u4: true, u8: false, braces: /^u\{([0-9A-Fa-f]{1,6})\}/, unknown: /^[xucCM]/, keepOther: false },
  perl: { simple: 'ntrfabe', hex: /^x([0-9A-Fa-f]{1,2})/, u4: false, u8: false, braces: /^x\{([0-9A-Fa-f]{1,6})\}/, unknown: /^[xNclLuUQEF]/, keepOther: false },
  php: { simple: 'ntrfve', hex: /^x([0-9A-Fa-f]{1,2})/, u4: false, u8: false, braces: /^u\{([0-9A-Fa-f]{1,6})\}/, unknown: /^u\{/, keepOther: true }
};

// The escapes the reader is sure of in each interpolating mode: backslash, quotes, sigils, `\\n`, `\\t`, `\\r`,
// `\\xHH`, and `\\uHHHH` where the language has it. Any other escape is still decoded as well as the
// reader can, but counts as unknown, so a capable program holding one blocks.
const INLINE_CERTAIN_ESCAPES = {
  python: /^(?:[\\'"ntr]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})/,
  js: /^(?:[\\'"`ntr]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})/,
  ruby: /^(?:[\\'"`#ntr]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})/,
  perl: /^(?:[\\'"`$@ntr]|x[0-9A-Fa-f]{2})/,
  php: /^(?:[\\'"`ntr$]|x[0-9A-Fa-f]{2})/
};

// The escape at `cursor` (a backslash) of a literal decoded with `mode`: its text, the index of its last
// character, and whether the reader does not know its value for certain.
function decodeEscape(program, cursor, mode, open, close) {
  const rest = program.slice(cursor + 1, cursor + 12);
  const next = rest[0] ?? '';
  const decoded = (text, length) => ({ text, end: cursor + length, unknown: false });
  const point = (digits, base, length) => {
    const value = parseInt(digits, base);
    return value > 0x10ffff ? { text: '', end: cursor + length, unknown: true } : decoded(String.fromCodePoint(value), length);
  };
  if (mode === 'raw') return decoded(`\\${next}`, 1);
  if (mode === 'single') return next === '\\' || next === open || next === close ? decoded(next, 1) : decoded(`\\${next}`, 1);
  const escape = decodeInterpolating(rest, next, decoded, point, INLINE_ESCAPES[mode], open, close);
  const certain = INLINE_CERTAIN_ESCAPES[mode].test(rest) || next === open || next === close;
  return certain ? escape : { ...escape, unknown: true };
}

function decodeInterpolating(rest, next, decoded, point, rules, open, close) {
  if (next === '\n') return decoded('', 1);
  let match;
  if (rules.braces && (match = rules.braces.exec(rest))) return point(match[1], 16, match[0].length);
  if ((match = rules.hex.exec(rest))) return point(match[1], 16, match[0].length);
  if (rules.u4 && (match = /^u([0-9A-Fa-f]{4})/.exec(rest))) return point(match[1], 16, match[0].length);
  if (rules.u8 && (match = /^U([0-9A-Fa-f]{8})/.exec(rest))) return point(match[1], 16, match[0].length);
  if ((match = /^[0-7]{1,3}/.exec(rest))) return point(match[0], 8, match[0].length);
  if (rules.unknown.test(rest)) return { ...decoded('', 1), unknown: true };
  if (rules.simple.includes(next)) return decoded(INLINE_SIMPLE_ESCAPES[next], 1);
  if ('\\\'"`$@'.includes(next) || next === open || next === close) return decoded(next, 1);
  return decoded(rules.keepOther ? `\\${next}` : next, 1);
}

// The end of a comment at `index`, or -1 when none starts there. `#{` is Ruby interpolation, not a comment.
function commentEnd(program, index, language) {
  const two = program.slice(index, index + 2);
  if ((language === 'js' || language === 'php') && two === '/*') {
    const close = program.indexOf('*/', index + 2);
    return close < 0 ? program.length : close + 2;
  }
  const line = (language === 'js' || language === 'php') && two === '//'
    || (['python', 'ruby', 'perl', 'php'].includes(language) && program[index] === '#' && program[index + 1] !== '{' && !(language === 'perl' && program[index - 1] === '$'));
  if (!line) return -1;
  const newline = program.indexOf('\n', index);
  return newline < 0 ? program.length : newline;
}

// A JavaScript regular expression literal starts at `index` when the code before it cannot end an operand.
function regexStart(program, index, language, code) {
  return language === 'js' && program[index] === '/' && !'/*'.includes(program[index + 1] ?? '')
    && /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn)\s*$/.test(code.slice(-20));
}

// The end of the regular expression literal that starts at `index`, flags included, or -1 unterminated.
function regexEnd(program, index) {
  let inClass = false;
  for (let cursor = index + 1; cursor < program.length; cursor += 1) {
    const character = program[cursor];
    if (character === '\\') { cursor += 1; continue; }
    if (character === '\n') return -1;
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && !inClass) {
      let end = cursor + 1;
      while (/[a-z]/.test(program[end] ?? '')) end += 1;
      return end;
    }
  }
  return -1;
}

// String literals of a program, without their delimiters (escapes keep the escaped character; paired
// delimiters nest), and the program's code with literal contents, regular expression literals, and
// comments removed. An executing literal leaves its opener in the code; an interpolating one is scanned
// again as code, two levels deep. `incomplete` is true when the reader did not follow the program to
// its end: the literal bound, an unterminated literal, or interpolation deeper than it rereads.
function scanProgram(program, language, depth = 0) {
  const literals = [];
  let code = '';
  let incomplete = false;
  let undecoded = false;
  let index = 0;
  while (index < program.length) {
    if (regexStart(program, index, language, code)) {
      const end = regexEnd(program, index);
      if (end < 0) { incomplete = true; break; }
      code += ' /r/ ';
      index = end;
      continue;
    }
    const opening = literalOpening(program, index, language);
    if (!opening) {
      const end = commentEnd(program, index, language);
      if (end < 0) code += program[index];
      index = end < 0 ? index + 1 : end;
      continue;
    }
    if (literals.length >= INLINE_MAX_LITERALS) { incomplete = true; break; }
    const open = opening.delimiter;
    const close = INLINE_PAIRS[open] ?? open;
    let body = '';
    let nesting = 1;
    let cursor = index + opening.opener.length;
    for (; cursor < program.length; cursor += 1) {
      const character = program[cursor];
      if (character === '\\') {
        const escape = decodeEscape(program, cursor, opening.escapes, open, close);
        body += escape.text;
        undecoded ||= escape.unknown;
        cursor = escape.end;
        continue;
      }
      if (close.length > 1) {
        if (program.startsWith(close, cursor)) break;
        body += character;
        continue;
      }
      if (close !== open && character === open) nesting += 1;
      else if (character === close && --nesting === 0) break;
      body += character;
    }
    if (cursor >= program.length) { incomplete = true; break; }
    literals.push(body);
    const interpolated = INLINE_INTERPOLATION.test(body) || (language === 'python' && /[fF][rRbB]?$|[rRbB][fF]$/.test(program.slice(Math.max(0, index - 2), index)) && body.includes('{'));
    let inner = '';
    if (interpolated && depth < 2) {
      const nested = scanProgram(body, language, depth + 1);
      literals.push(...nested.literals);
      incomplete ||= nested.incomplete;
      undecoded ||= nested.undecoded;
      inner = nested.code;
    } else if (interpolated) incomplete = true;
    code += `${opening.executes ? opening.opener : ''} ${inner} `;
    index = cursor + close.length;
  }
  return { literals, code, incomplete, undecoded };
}

// The inline program of a normalized command entry, or null when it runs none. `dynamic` is true when
// the program is not known before the command runs (`-c "$CODE"`, a word xargs supplies): the command
// is then ambiguous. Ruby and perl accept several `-e`, and interpreters disagree on which word a
// program option takes when another option follows it (Node runs `-p -e CODE` as CODE, Bun as `-e`), so
// every candidate word is kept and the scan continues from the word after the option.
export function inlineProgram(entry) {
  if (!entry?.tokens?.length) return null;
  const name = executableName(entry.tokens[0]);
  const known = INLINE_PROGRAM_OPTIONS.find(([executable]) => executable.test(name));
  if (!known) return null;
  const [, option, toEnd, language, region] = known;
  const shellLike = language === 'cmd';
  const isOption = (value) => (region.option ? region.option.test(value) : value.length > 1 && value.startsWith('-'));
  const parts = [];
  let dynamic = false;
  for (let index = 1; index < entry.tokens.length; index += 1) {
    const token = entry.tokens[index];
    const match = option.exec(token.value);
    if (!match) {
      // A word known only at run time may be an option: keep reading rather than stop (fail closed).
      if (token.dynamic || token.placeholder) continue;
      if (token.value === '--') break;
      if (!isOption(token.value)) {
        if (region.continues?.has(token.value)) continue;
        break;
      }
      if (region.stops?.test(token.value)) break;
      const next = entry.tokens[index + 1];
      if (!region.option && !token.value.includes('=') && next && !isOption(next.value)) index += 1;
      continue;
    }
    // A program attached to its option is part of the same word; otherwise it is the next word.
    const attached = match[1] !== '' || /=$/.test(entry.tokens[index].value);
    const first = attached ? index : index + 1;
    const words = toEnd ? entry.tokens.slice(first) : entry.tokens.slice(first, first + 1);
    if (!words.length) continue;
    dynamic ||= words.some((token) => token.dynamic || token.placeholder);
    parts.push([...(attached ? [match[1]] : []), ...words.slice(attached ? 1 : 0).map((token) => token.value)].join(' '));
    if (toEnd) break;
    // The program word is skipped; a word that looks like an option is read again as one.
    if (attached || !isOption(words[0].value)) index = first;
  }
  if (!parts.length) return null;
  const text = parts.join('\n');
  const { literals, code, incomplete, undecoded } = scanProgram(text, language);
  const capable = shellLike || INLINE_CAPABLE[language].test(code);
  // A capable program is ambiguous, and so is one the reader did not follow to the end, whatever the
  // read part holds: the unread part may run anything.
  const ambiguous = !shellLike && (capable || incomplete);
  // The literals joined without and with a space, so a hook deciding whether the text concerns it also
  // sees a command split across adjacent literals (`'n' 'pm publish'`).
  // ponytail: joins every literal, not only adjacent ones; extra joins only widen what looks relevant.
  const literalText = `${literals.join('')}\n${literals.join(' ')}`;
  // A capable program with a literal whose value the reader does not know for certain, or with a
  // here-document, counts as relevant to every hook.
  // ponytail: the here-document test is textual; a Ruby `a<<b` shift in a capable program also blocks.
  const heredoc = Boolean(INLINE_HEREDOC[language]?.test(text));
  return { text, dynamic, shellLike, literals, capable, ambiguous, literalText, relevant: capable && (undecoded || heredoc) };
}

// Normalized commands (the shape parseShellCommands returns) found in the inline program of `entry`.
// Without `capable`, the literals are data and nothing is returned. With it, every literal is read as a
// shell command, so a static command gets its concrete rule, and one `{ ambiguous: true }` entry follows
// them: the program may build a command from pieces (`'npm ' 'publish'`, a here-document, a variable).
// A hook refuses that entry when the command text looks relevant to it. Candidates that do not parse
// are skipped. A literal that runs a shell without a static command (`sh`), a program not known before
// the command runs, and a program the reader did not follow to the end are ambiguous too. The
// program-level entry carries no wrappers (a shell around the one-liner adds nothing unknown), the
// program's joined and decoded literals as `text`, for the hook's relevance check, and `relevant` when a
// literal holds an escape the reader does not decode.
export function inlineShellCommands(entry) {
  const program = inlineProgram(entry);
  if (!program) return [];
  if (program.dynamic) return [{ ambiguous: true, tokens: [], wrappers: entry.wrappers ?? [] }];
  const unfollowed = { ambiguous: true, tokens: [], wrappers: [], text: program.literalText, relevant: program.relevant };
  if (!program.capable) return program.ambiguous ? [unfollowed] : [];
  const sources = [...(program.shellLike ? [program.text] : []), ...program.literals];
  const commands = [];
  for (const source of sources) {
    const parsed = parseShellCommands(source, 1, [...(entry.wrappers ?? []), executableName(entry.tokens[0])], { redirections: true });
    if (!parsed.error) commands.push(...parsed.commands.filter((command) => command.tokens?.length || command.redirections?.length || command.ambiguous));
  }
  if (program.ambiguous) commands.push(unfollowed);
  return commands;
}
// </youdede:shared>

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = SHELL_MAX_COMMAND_BYTES;
const ALLOW = { exitCode: 0 };
const BLOCK = (ruleId, reason) => ({ exitCode: 2, ruleId, message: `BLOCKED by package-publish-guard [${ruleId}]: ${reason}` });
const UNINSPECTABLE = 'package-publish-command-uninspectable';
const suspect = (command) => /\b(?:publish|upload)\b|\b(?:gem|nuget)\b[^\n]*\bpush\b/i.test(command);
// The executable's base name and its arguments; values that xargs or find supply at run time count
// as dynamic.
// A segment of redirections alone (`> file`) has no executable.
function view(entry) {
  const args = entry.tokens.slice(1).map((token) => (token.placeholder ? { value: token.value, dynamic: true } : token));
  const executable = entry.tokens.length ? executableName(entry.tokens[0]) : '';
  return { executable, args, dynamic: args.some((token) => token.dynamic), redirections: entry.redirections ?? [] };
}

function skipOption(tokens, index, takesValue) {
  const token = tokens[index]?.value || '';
  if (!token.startsWith('-') || token === '--') return index;
  if (!token.includes('=') && takesValue.has(token)) return index + 2;
  return index + 1;
}

function stripLeadingOptions(args, valueOptions = new Set()) {
  let index = 0;
  while (args[index]?.value.startsWith('-') && args[index].value !== '--') index = skipOption(args, index, valueOptions);
  if (args[index]?.value === '--') index += 1;
  return args.slice(index);
}

// First rule hit among the normalized commands and the commands written inside their interpreter
// one-liners. A command the analysis cannot follow is refused when the text looks relevant, or when a
// shell or eval runs text that is not known here (`curl … | sh`, `bash script.sh`, `eval "$X"`).
function firstRule(command, policy, suspect, uninspectable) {
  if (typeof command !== 'string') return uninspectable;
  const parsed = parseShellCommands(command, 0, [], { redirections: true });
  if (parsed.error) return uninspectable;
  for (const entry of parsed.commands) {
    // An inline program the analysis cannot follow is ambiguous too: one known only at run time
    // (`python3 -c "$CODE"`), or one that names something able to run a command.
    for (const candidate of entry.ambiguous ? [entry] : [entry, ...inlineShellCommands(entry)]) {
      if (candidate.ambiguous) {
        // `text` holds an inline program's joined, decoded literals, so a command split across them or
        // written with escapes still counts; `relevant` marks a literal whose value the reader does not know.
        if (candidate.relevant || suspect(command) || (candidate.text !== undefined && suspect(candidate.text))
          || candidate.wrappers.some((name) => SHELL_NAMES.has(name) || name === 'eval')) return uninspectable;
        continue;
      }
      const ruleId = policy(view(candidate));
      if (ruleId) return ruleId;
    }
  }
  return null;
}

const PUBLISH_GLOBAL_VALUES = new Set(['--workspace', '-w', '--filter', '-C', '--dir']);
const dryRun = (args) => args.some((token) => token.value === '--dry-run' || token.value === '--dry-run=true');

function policy(entry) {
  const args = stripLeadingOptions(entry.args, PUBLISH_GLOBAL_VALUES);
  // `npm "$@"` in a shell function: the subcommand is unknown.
  if (['npm', 'pnpm', 'bun', 'yarn'].includes(entry.executable) && args[0]?.dynamic) return UNINSPECTABLE;
  if (['npm', 'pnpm', 'bun'].includes(entry.executable)) {
    if (args[0]?.value !== 'publish' || dryRun(args)) return null;
    return entry.dynamic ? UNINSPECTABLE : 'javascript-package-publish';
  }
  if (entry.executable === 'yarn') {
    // Yarn 1 publishes with `yarn publish`, Yarn 2+ with `yarn npm publish`.
    if ((args[0]?.value === 'npm' && args[1]?.value === 'publish') || args[0]?.value === 'publish') return dryRun(args) ? null : 'yarn-package-publish';
    return null;
  }
  if (/^(?:python(?:\d+(?:\.\d+)*)?|py)$/.test(entry.executable) && entry.args[0]?.value === '-m' && entry.args[1]?.value === 'twine' && entry.args[2]?.value === 'upload') return 'python-package-publish';
  if (entry.executable === 'twine' && args[0]?.value === 'upload') return 'python-package-publish';
  if (['poetry', 'uv', 'hatch', 'flit'].includes(entry.executable) && args[0]?.value === 'publish') return dryRun(args) ? null : 'python-package-publish';
  if (entry.executable === 'cargo' && args[0]?.value === 'publish') return dryRun(args) ? null : 'native-package-publish';
  if ((entry.executable === 'gem' && args[0]?.value === 'push') || (entry.executable === 'dotnet' && args[0]?.value === 'nuget' && args[1]?.value === 'push') || (entry.executable === 'nuget' && args[0]?.value === 'push')) return 'native-package-publish';
  return null;
}

export function evaluate(input) {
  if (!input || typeof input !== 'object' || !input.tool_input || typeof input.tool_input !== 'object') return BLOCK('package-publish-input-invalid', 'the hook input is malformed.');
  if (input.tool_name !== 'Bash') return ALLOW;
  const ruleId = firstRule(input.tool_input.command, policy, suspect, UNINSPECTABLE);
  if (!ruleId) return ALLOW;
  return ruleId === UNINSPECTABLE
    ? BLOCK(ruleId, 'the package publication command cannot be normalized safely.')
    : BLOCK(ruleId, 'the command publishes a package to a registry; ask the user to run it after review.');
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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const result = evaluate(await readInput());
    if (result.exitCode) process.stderr.write(`${result.message}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('BLOCKED by package-publish-guard [package-publish-input-invalid]: hook input is invalid or oversized.\n');
    process.exitCode = 2;
  }
}
