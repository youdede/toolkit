#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
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
export const MAX_CONTENT_BYTES = 512 * 1024;
export const MAX_COMMAND_BYTES = SHELL_MAX_COMMAND_BYTES;
const ALLOW = { exitCode: 0 };
const BLOCK = (ruleId, reason) => ({ exitCode: 2, ruleId, message: `BLOCKED by container-privilege-guard [${ruleId}]: ${reason}` });
const CONTAINER_TEXT = /\b(?:docker|podman)\b/i;
const GLOBAL_VALUE_OPTIONS = new Set(['--config', '--context', '-c', '--host', '-H', '--log-level']);
const NAMESPACE_OPTION = /^--(?:pid|ipc|network|net|uts|userns|cgroupns)$/i;
const DANGEROUS_CAPABILITY = /^(?:CAP_)?(?:SYS_ADMIN|SYS_PTRACE|NET_ADMIN|ALL)$/i;

function skipOption(tokens, index, values) { const token = tokens[index]?.value || ''; if (!token.startsWith('-') || token === '--') return index; return !token.includes('=') && values.has(token) ? index + 2 : index + 1; }

// A command the shared analysis cannot unwrap blocks when it may hide a container engine: its text
// names one, or a shell or eval layer runs a script that cannot be read.
function hidesContainerEngine(entry, command) {
  return entry.ambiguous && (CONTAINER_TEXT.test(command) || entry.wrappers.some((name) => SHELL_NAMES.has(name) || name === 'eval'));
}

// Value of `--name=value` or `--name value` at args[offset], or null.
function optionValue(args, offset, pattern) {
  const [name, ...rest] = args[offset].split('=');
  if (!pattern.test(name)) return null;
  return rest.length ? rest.join('=') : args[offset + 1] ?? '';
}

function commandRule(command) {
  if (typeof command !== 'string') throw new Error('invalid command');
  const normalized = parseShellCommands(command);
  if (normalized.error) throw new Error('uninspectable shell');
  if (normalized.commands.some((entry) => hidesContainerEngine(entry, command))) return 'container-command-uninspectable';
  for (const entry of normalized.commands) {
    if (!entry.tokens || !['docker', 'podman'].includes(executableName(entry.tokens[0]))) continue;
    const tokens = entry.tokens.slice(1);
    if (tokens.some((token) => token.dynamic || token.placeholder)) return 'container-command-uninspectable';
    let index = 0;
    while (tokens[index]?.value.startsWith('-')) index = skipOption(tokens, index, GLOBAL_VALUE_OPTIONS);
    if (tokens[index]?.value.toLowerCase() === 'container') index += 1;
    if (!['run', 'create'].includes(tokens[index]?.value.toLowerCase())) continue;
    const args = tokens.slice(index + 1).map((token) => token.value);
    if (args.some((value) => /^--privileged(?:=true)?$/i.test(value))) return 'container-privileged-mode';
    if (args.some((value, offset) => optionValue(args, offset, NAMESPACE_OPTION)?.toLowerCase() === 'host')) return 'container-host-namespace';
    if (args.some((value, offset) => DANGEROUS_CAPABILITY.test(optionValue(args, offset, /^--cap-add$/i) ?? ''))) return 'container-dangerous-capability';
    if (args.some((value, offset) => /^(?:-v|--volume)=?.*\/var\/run\/docker\.sock/i.test(value) || (/^(?:-v|--volume)$/.test(value) && /\/var\/run\/docker\.sock/.test(args[offset + 1] || '')))) return 'container-engine-socket';
    if (args.some((value) => /^--device(?:=|$)/.test(value))) return 'container-device-passthrough';
  }
  return null;
}

// Capabilities a Compose `cap_add` or a Kubernetes `capabilities.add` lists, inline or as a block.
function addedCapabilities(lines) {
  const added = [];
  lines.forEach((line, index) => {
    const key = /^(\s*)(cap_add|add)\s*:\s*(.*)$/i.exec(line);
    if (!key) return;
    const indent = key[1].length;
    if (key[2].toLowerCase() === 'add') {
      const parent = lines.slice(0, index).reverse().find((previous) => previous.trim() && /^\s*/.exec(previous)[0].length < indent);
      if (!parent || !/^\s*capabilities\s*:\s*$/i.test(parent)) return;
    }
    if (key[3].trim()) { added.push(...key[3].replace(/[[\]"']/g, '').split(',').map((value) => value.trim())); return; }
    for (const next of lines.slice(index + 1)) {
      if (!next.trim()) continue;
      const item = /^(\s*)-\s*["']?([^"'\s]+)["']?\s*$/.exec(next);
      if (!item || item[1].length < indent) break;
      added.push(item[2]);
    }
  });
  return added;
}

function isContainerConfig(filePath) { return /(?:^|\/)(?:docker-compose[^/]*\.ya?ml|compose\.ya?ml|dockerfile(?:\.[^/]*)?|(?:k8s|kubernetes|deploy|charts?|helm)\/[^/]+\.ya?ml)$/i.test(String(filePath || '').replaceAll('\\', '/')); }
export function scanContainerConfig(source) {
  const lines = source.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, '')); const findings = [];
  if (lines.some((line) => /^\s*privileged\s*:\s*true\s*$/i.test(line))) findings.push('container-privileged-mode');
  if (lines.some((line) => /^\s*host(?:PID|IPC|Network)\s*:\s*true\s*$/i.test(line) || /^\s*(?:network_mode|pid|ipc|uts|userns_mode)\s*:\s*["']?host["']?\s*$/i.test(line))) findings.push('container-host-namespace');
  if ((lines.some((line) => /^\s*(?:cap_add|capabilities)\s*:/i.test(line)) && lines.some((line) => /(?:SYS_ADMIN|SYS_PTRACE|NET_ADMIN)/i.test(line)))
    || addedCapabilities(lines).some((name) => DANGEROUS_CAPABILITY.test(name))) findings.push('container-dangerous-capability');
  if (lines.some((line) => /^\s*(?:-\s*)?(?:source\s*:\s*)?["']?\/var\/run\/docker\.sock\b/i.test(line) || /^\s*-\s*["']?[^\s]*\/var\/run\/docker\.sock/i.test(line))) findings.push('container-engine-socket');
  if (lines.some((line) => /^\s*devices\s*:\s*(?:\[.*\])?\s*$/i.test(line))) findings.push('container-device-passthrough');
  return findings;
}

function safePath(filePath, cwd) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw new Error('invalid path'); const root = realpathSync(cwd); const target = path.resolve(root, filePath); const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('outside project'); let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); if (!existsSync(cursor)) break; if (lstatSync(cursor).isSymbolicLink()) throw new Error('symlink path'); } return target;
}
function readBounded(filePath) { if (!existsSync(filePath)) return ''; const stat = lstatSync(filePath); if (!stat.isFile() || stat.size > MAX_CONTENT_BYTES) throw new Error('uninspectable file'); return readFileSync(filePath, 'utf8'); }
function replaceExactly(source, edit) { if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string' || !edit.old_string) throw new Error('invalid edit'); const first = source.indexOf(edit.old_string); if (first < 0) throw new Error('old text missing'); if (edit.replace_all === true) return source.split(edit.old_string).join(edit.new_string); if (source.indexOf(edit.old_string, first + edit.old_string.length) >= 0) throw new Error('ambiguous edit'); return source.slice(0, first) + edit.new_string + source.slice(first + edit.old_string.length); }
export function reconstructChange(input, cwd = process.cwd()) {
  if (!input || !['Write', 'Edit', 'MultiEdit'].includes(input.tool_name) || !input.tool_input) return { relevant: false }; const filePath = input.tool_input.file_path || input.tool_input.file; if (!isContainerConfig(filePath)) return { relevant: false }; const target = safePath(filePath, cwd); const before = readBounded(target); let after;
  if (input.tool_name === 'Write') { if (typeof input.tool_input.content !== 'string') throw new Error('missing content'); after = input.tool_input.content; }
  else if (input.tool_name === 'Edit') { if (!existsSync(target)) throw new Error('missing target'); after = replaceExactly(before, input.tool_input); }
  else { if (!existsSync(target) || !Array.isArray(input.tool_input.edits) || !input.tool_input.edits.length) throw new Error('invalid edits'); after = input.tool_input.edits.reduce(replaceExactly, before); }
  if (Buffer.byteLength(after) > MAX_CONTENT_BYTES) throw new Error('oversized content'); return { relevant: true, filePath, before, after };
}
function introduced(before, after) { const counts = new Map(); for (const rule of scanContainerConfig(before)) counts.set(rule, (counts.get(rule) || 0) + 1); for (const rule of scanContainerConfig(after)) { const remaining = counts.get(rule) || 0; if (remaining) counts.set(rule, remaining - 1); else return rule; } return null; }

export function evaluate(input, context) {
  if (!input || typeof input !== 'object' || !input.tool_input || typeof input.tool_input !== 'object') return BLOCK('container-input-invalid', 'the hook input is malformed.');
  if (input.tool_name === 'Bash') { try { const ruleId = commandRule(input.tool_input.command); return ruleId ? BLOCK(ruleId, 'the command grants a container high-impact host privileges.') : ALLOW; } catch { return BLOCK('container-command-uninspectable', 'the container command cannot be normalized safely.'); } }
  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) return ALLOW;
  const filePath = input.tool_input.file_path || input.tool_input.file; if (!isContainerConfig(filePath)) return ALLOW; let change = context;
  if (!change && input.tool_name === 'Write' && typeof input.tool_input.content === 'string') change = { relevant: true, before: '', after: input.tool_input.content };
  if (!change || change.invalid || typeof change.before !== 'string' || typeof change.after !== 'string' || Buffer.byteLength(change.after) > MAX_CONTENT_BYTES) return BLOCK('container-input-invalid', 'the complete proposed container configuration cannot be inspected safely.');
  if (!change.relevant) return ALLOW; const ruleId = introduced(change.before, change.after); return ruleId ? BLOCK(ruleId, 'the proposed container configuration expands host privilege.') : ALLOW;
}

async function readInput() { const chunks = []; let size = 0; for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_STDIN_BYTES) throw new Error('oversized'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { const input = await readInput(); const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(); const context = input.tool_name === 'Bash' ? undefined : reconstructChange(input, cwd); const result = evaluate(input, context); if (result.exitCode) process.stderr.write(`${result.message}\n`); process.exitCode = result.exitCode; }
  catch { process.stderr.write('BLOCKED by container-privilege-guard [container-input-invalid]: hook input is invalid or oversized.\n'); process.exitCode = 2; }
}
