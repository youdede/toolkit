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
      let fd = '';
      if (token && !token.quoted && !token.dynamic && /^\d+$/.test(token.value)) { fd = token.value; operator = fd + operator; token = null; }
      pushToken();
      if (redirect) return { error: 'redirection without target' };
      if (options.redirections) redirections.push({ operator, target: { value: heredoc.delimiter, dynamic: false } });
      else tokens.push({ value: operator + heredoc.delimiter, dynamic: false, heredoc, fd });
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
    } else if (!options.redirections && character === '<' && source.startsWith('<<<', index)) {
      // A here-string: the next word is the input of the command, standard input unless a file
      // descriptor number is written right before it (`0<<<` is standard input too).
      let fd = '';
      if (token && !token.quoted && !token.dynamic && /^\d+$/.test(token.value)) { fd = token.value; token = null; }
      pushToken();
      tokens.push({ value: `${fd}<<<`, dynamic: false, herestring: true, fd });
      index += 2;
    } else if (!options.redirections && character === '<' && source[index + 1] !== '(') {
      // An input redirection (`< file`, `<file`): marked so a shell reading it is not given a script name.
      begin();
      token.value += character;
      token.input = true;
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
        // A here-string or here-document on standard input (no descriptor number, or 0) gives the shell
        // its program: a static one is read as commands. Every other input redirection (`< file`, `0<>`,
        // `<&3`, a here-string on another descriptor) is ambiguous. Their words are never a script name.
        // The last input wins, as in bash.
        const feeds = [];
        const rest = [];
        for (let position = index + 1; position < tokens.length; position += 1) {
          const token = tokens[position];
          const stdinFeed = !token.fd || token.fd === '0';
          if (token.heredoc) {
            const { body, quoted } = token.heredoc;
            feeds.push(stdinFeed && (quoted || !/[$`\\]/.test(body)) ? { text: body } : { dynamic: true });
          } else if (token.herestring) {
            const word = tokens[position + 1];
            position += 1;
            feeds.push(stdinFeed && word && !word.dynamic && !word.placeholder ? { text: word.value } : { dynamic: true });
          } else if (token.input) {
            feeds.push({ dynamic: true });
            if (/^\d*<[>&]?$/.test(token.value)) position += 1;
          } else rest.push(token);
        }
        tokens = [...tokens.slice(0, index + 1), ...rest];
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

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = SHELL_MAX_COMMAND_BYTES;

const DYNAMIC_SENSITIVE_EXECUTABLES = new Set([
  'rm', 'dd', 'mkfs', 'diskutil', 'chmod', 'chown', 'gh', 'op', 'pass', 'bw', 'bws', 'lpass',
  'keepassxc-cli', 'rbw', 'nordpass', 'security', 'gpg', 'docker', 'podman', 'crontab'
]);
const GH_TEXT_OPTION = /^(?:-t|--title|-b|--body|-n|--notes)$/;
const BROAD_DELETE_TARGET = /^(?:\/\*?|~\/?\*?|\$HOME\/?\*?|\$\{HOME\}\/?\*?|\/Users\/?\*?)$/;

// Patterns match one normalized command: the executable's base name followed by its arguments.
// Rules with `test` inspect the tokens instead; `next` is the command after it.
export const RULES = [
  {
    id: 'broad-filesystem-delete',
    reason: 'recursive deletion targets a system, home, or all-users root',
    pattern: /$a/,
    // rm accepts options after operands, so every operand is checked.
    test: (entry) => executableName(entry.tokens[0]) === 'rm' && operands(entry.tokens.slice(1)).some((token) => BROAD_DELETE_TARGET.test(token.value))
  },
  {
    id: 'sudo-rm',
    reason: 'rm is being given administrator authority',
    pattern: /$a/,
    test: (entry) => executableName(entry.tokens[0]) === 'rm' && entry.wrappers.includes('sudo')
  },
  {
    id: 'raw-disk-write',
    reason: 'the command writes to or formats a raw disk device',
    pattern: /^(?:dd\s+[^;&|\n]*\bof=["']?\/dev\/(?:r?disk|sd[a-z]|nvme)|mkfs(?:\.[A-Za-z0-9]+)?(?:\s|$)|diskutil\s+(?:erase\w*|partitionDisk|zeroDisk|secureErase|apfs\s+(?:delete|erase)\w*))/i
  },
  {
    id: 'raw-device-redirection',
    reason: 'output redirection targets a raw disk device',
    pattern: />\s*\/dev\/(?:r?disk\d*|sd[a-z]\d*|nvme\w*)/
  },
  {
    id: 'fork-bomb',
    reason: 'the command contains a shell fork bomb',
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/m
  },
  {
    id: 'internet-to-shell',
    reason: 'remote content is piped directly into a shell',
    pattern: /$a/,
    test: (entry, next) => ['curl', 'wget'].includes(executableName(entry.tokens[0])) && Boolean(next)
      && (Boolean(next.tokens?.length && SHELL_NAMES.has(executableName(next.tokens[0])))
        || (entry.operator === '|' && next.wrappers?.some((wrapper) => SHELL_NAMES.has(wrapper))))
  },
  {
    id: 'forced-remote-history',
    reason: 'git push would rewrite remote history without force-with-lease',
    pattern: /$a/,
    test: (entry) => pushArguments(entry).some((value) => value === 'force')
  },
  {
    id: 'remote-ref-delete',
    reason: 'git push would delete a remote branch or tag',
    pattern: /$a/,
    test: (entry) => pushArguments(entry).some((value) => value === 'delete')
  },
  {
    id: 'system-permission-destruction',
    reason: 'recursive ownership or world-writable permissions target the system root',
    pattern: /^(?:chmod\s+[^;&|\n]*\b777\s+["']?\/["']?(?=\s*(?:$|[;&|]))|chown\s+-R[^;&|\n]*\s+["']?\/["']?(?=\s*(?:$|[;&|])))/
  },
  {
    id: 'recovery-history-destruction',
    reason: 'Git recovery history would be made immediately unrecoverable',
    pattern: /$a/,
    test: (entry) => {
      const git = gitCommand(entry);
      const rest = git?.args.map((token) => token.value).join(' ') ?? '';
      return (git?.name === 'reflog' && git.args[0]?.value === 'expire' && /--expire(?:-unreachable)?(?:=|\s+)now/.test(rest))
        || (git?.name === 'gc' && /--prune(?:=|\s+)(?:now|all)/.test(rest));
    }
  },
  {
    id: 'destructive-github-operation',
    reason: 'the GitHub command performs an irreversible or account-sensitive action',
    pattern: /^gh\s+(?:repo\s+delete(?:\s|$)|release\s+delete(?:\s|$)|(?:secret|ssh-key|gpg-key)\s+delete(?:\s|$)|api\s+[^;&|\n]*(?:-X|--method)(?:=|\s+)(?:DELETE|delete)|repo\s+edit[^;&|\n]*--visibility(?:=|\s+)public|auth\s+token(?:\s|$))/
  },
  {
    id: 'credential-store-access',
    reason: 'the command reads or exports secrets from a password manager, keychain, or secret key store',
    pattern: /^(?:(?:bw|bws|lpass|keepassxc-cli|rbw|nordpass)(?:\s|$)|pass\s+(?!--(?:help|version)(?:\s|$))\S+|op\s+(?:read|run|inject|item|document|vault|connect|service-account|events-api|signin)(?:\s|$)|security\s+(?:(?:-[A-Za-z]+|--[a-z-]+)\s+)*(?:find-generic-password|find-internet-password|dump-keychain)(?:\s|$)|gpg\s+[^;&|\n]*--export-secret-(?:keys?|subkeys)(?:\s|=|$)|[^;&|\n]*(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s"']+)\/\.password-store(?:\/|\s|$))/
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

function operands(args) {
  const separator = args.findIndex((token) => token.value === '--');
  const before = separator < 0 ? args : args.slice(0, separator);
  return [...before.filter((token) => !token.value.startsWith('-')), ...(separator < 0 ? [] : args.slice(separator + 1))];
}

function gitCommand(entry) {
  if (executableName(entry.tokens[0]) !== 'git') return null;
  const invocation = gitInvocation(entry.tokens);
  return invocation.ambiguous || !invocation.name ? null : invocation;
}

// 'force' and 'delete' markers of `git push` arguments. -f, --force, or a +refspec forces the push even
// with --force-with-lease or --force-if-includes (verified with Git 2.54), so only a lease alone passes.
// Short option groups such as -uf count; -o takes the rest of its group.
function pushArguments(entry) {
  const git = gitCommand(entry);
  if (git?.name !== 'push') return [];
  const markers = [];
  for (const token of git.args) {
    const value = token.value;
    if (value === '--delete' || /^:[A-Za-z0-9._/-]/.test(value)) markers.push('delete');
    if (/^--force(?:=\S*)?$/.test(value) || /^\+[A-Za-z0-9._/-]/.test(value)) markers.push('force');
    if (/^-[A-Za-z]+$/.test(value)) {
      const group = value.slice(1).split('o')[0];
      if (group.includes('d')) markers.push('delete');
      if (group.includes('f')) markers.push('force');
    }
  }
  return markers;
}

function candidate(entry) {
  return [executableName(entry.tokens[0]), ...entry.tokens.slice(1).map((token) => token.value)].join(' ');
}

function optionPresent(args, longName, shortName) {
  return args.some((token) => {
    if (token.dynamic) return false;
    const value = token.value;
    const folded = value.toLowerCase();
    if (folded === longName || folded.startsWith(`${longName}=`)) return true;
    return shortName && /^-[^-]+$/.test(value) && value.slice(1).includes(shortName);
  });
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
        || args.some((token) => ['.', ':/'].includes(token.value))
        || optionPresent(args, '--force', 'f')) return 'local-worktree-destruction';
    }
    if (name === 'switch' && (optionPresent(args, '--force', 'f') || optionPresent(args, '--discard-changes', null))) {
      return 'local-worktree-destruction';
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
  const normalized = parseShellCommands(command);
  // `curl … | sh`: the shell reads a script the analysis cannot see, but the pipe itself is the finding.
  const piped = RULES.find((rule) => rule.id === 'internet-to-shell');
  if (normalized.commands.some((entry, index) => entry.tokens?.length && piped.test(entry, normalized.commands[index + 1]))) {
    return {
      exitCode: 2,
      ruleId: piped.id,
      message: `BLOCKED by shell-command-guard [${piped.id}]: ${piped.reason}. Do not retry or work around this guard; explain the blocked action to the user.`
    };
  }
  if (normalized.error || normalized.commands.some((entry) => entry.ambiguous)) {
    return {
      exitCode: 2,
      ruleId: 'shell-command-uninspectable',
      message: 'BLOCKED by shell-command-guard [shell-command-uninspectable]: the command cannot be normalized safely. Expand dynamic command construction before retrying.'
    };
  }
  // Rules see each normalized command on its own, so text quoted inside an argument never matches.
  // Words xargs supplies at run time can be any option or operand (`printf / | xargs rm -rf`), so they
  // count as dynamic; a `find -exec` `{}` is a path find produced and keeps its value.
  const commands = normalized.commands.filter((entry) => entry.tokens?.length).map((entry) => (entry.wrappers?.includes('xargs')
    ? { ...entry, tokens: entry.tokens.map((token) => (token.placeholder ? { ...token, dynamic: true } : token)) }
    : entry));
  let matchedRule = RULES.find((rule) => commands.some((entry, index) => (rule.test
    ? rule.test(entry, commands[index + 1])
    : rule.pattern.test(candidate(entry)))));
  if (!matchedRule) {
    const deterministicRule = commands.map(deterministicCommandRule).find(Boolean);
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
    const dynamicSensitive = commands.some((entry) => {
      if (!entry.tokens.slice(1).some((token) => token.dynamic)) return false;
      const executable = executableName(entry.tokens[0]);
      // `gh pr create --body "$(cat <<'EOF' …)"`: a title, body, or notes text cannot change the subcommand.
      if (executable === 'gh') return entry.tokens.slice(1).some((token, index, args) => token.dynamic && !GH_TEXT_OPTION.test(args[index - 1]?.value ?? ''));
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
