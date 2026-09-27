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

// Bash brace expansion of a word given as [character, unquoted] pairs: comma lists `{a,b}` (nested
// too), sequences `{x..y}` and `{x..y..step}` of integers (zero-padded when an end has a leading zero)
// or single letters. Only unquoted `{`, `,`, `}` count, and an invalid form (`{a}`, `{}`, `{x..}`)
// stays literal. Returns { words, kept, certain }: `words` stops after SHELL_MAX_BRACE_WORDS + 1
// results, `kept[i]` is false for a null word (no character and no quotes, which bash removes: `{,npm}`
// is just `npm`; a quote is an entry ['', false]), and `certain` is false when a form is not known for
// certain (a zero step, a negative padded end).
const SHELL_MAX_BRACE_WORDS = 64;
// ponytail: a longer word is not expanded (each group rescans the word); it stays dynamic, whole.
const SHELL_MAX_BRACE_LENGTH = 1024;
function braceExpand(chars, out = { words: [], kept: [], certain: true }) {
  for (let open = 0; open < chars.length; open += 1) {
    if (chars[open][0] !== '{' || !chars[open][1]) continue;
    let depth = 0;
    let close = -1;
    const commas = [];
    for (let index = open; index < chars.length && close < 0; index += 1) {
      const [character, unquoted] = chars[index];
      if (!unquoted) continue;
      if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) close = index;
      else if (character === ',' && depth === 1) commas.push(index);
    }
    if (close < 0) continue;
    let parts = null;
    if (commas.length) {
      const bounds = [open, ...commas, close];
      parts = bounds.slice(1).map((end, position) => chars.slice(bounds[position] + 1, end));
    } else {
      const sequence = braceSequence(chars.slice(open + 1, close));
      if (sequence) {
        out.certain &&= sequence.certain;
        parts = sequence.values.map((value) => value.split('').map((character) => [character, false]));
      }
    }
    if (!parts) continue;
    for (const part of parts) {
      if (out.words.length > SHELL_MAX_BRACE_WORDS) break;
      braceExpand([...chars.slice(0, open), ...part, ...chars.slice(close + 1)], out);
    }
    return out;
  }
  out.words.push(chars.map(([character]) => character).join(''));
  out.kept.push(chars.length > 0);
  return out;
}

// What an unquoted glob word may match, for a hook's text: every alternative of its bracket sets
// (`n[px]m`) and pattern groups (`n@(p|x)m`), and its literal text. `wild` is true when the word can
// match anything the text cannot list: `*`, `?`, a negated or class bracket, a repeated, negated, or
// nested group, or more than SHELL_MAX_GLOB_WORDS alternatives.
const SHELL_MAX_GLOB_WORDS = 16;
function globAlternatives(text) {
  let words = [''];
  let wild = false;
  const append = (options) => {
    words = words.flatMap((word) => options.map((option) => word + option));
    if (words.length > SHELL_MAX_GLOB_WORDS) { wild = true; words = words.slice(0, SHELL_MAX_GLOB_WORDS); }
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const group = character === '(' || ('@*+?!'.includes(character) && text[index + 1] === '(');
    if (group) {
      const start = character === '(' ? index : index + 1;
      const end = patternGroupEnd(text, start);
      if (end > 0) {
        const inner = text.slice(start + 1, end - 1);
        if ('*+!'.includes(character) || /[()[*?]/.test(inner)) wild = true;
        else append([...(character === '?' ? [''] : []), ...inner.split('|')]);
        index = end - 1;
        continue;
      }
    }
    if (character === '*' || character === '?') { wild = true; continue; }
    const close = character === '[' ? text.indexOf(']', index + 2) : -1;
    if (close > 0) {
      const set = bracketSet(text.slice(index + 1, close));
      if (set) append(set); else wild = true;
      index = close;
      continue;
    }
    append([character]);
  }
  return { words, wild };
}

// The characters a bracket expression lists (`pq`, `a-c`), or null for a negated set, a class, or a
// range wider than SHELL_MAX_GLOB_WORDS.
function bracketSet(body) {
  if (/^[!^]|\[:|\[=|\[\./.test(body)) return null;
  const set = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index + 1] === '-' && index + 2 < body.length) {
      const from = body.charCodeAt(index);
      const to = body.charCodeAt(index + 2);
      if (to < from || to - from >= SHELL_MAX_GLOB_WORDS) return null;
      for (let code = from; code <= to; code += 1) set.push(String.fromCharCode(code));
      index += 2;
    } else set.push(body[index]);
  }
  return set.length ? [...new Set(set)] : null;
}

// Whether an unquoted glob argument may decide what `entry` does, for a hook that protects its
// executable: `words` is how many leading words that are not options decide the operation (`npm
// publish` 1, `aws ec2 terminate-instances` 2, Infinity when every word may). A glob among them, among
// the options before them, or an option glob anywhere (`--pu*`) may spell the protected verb or option,
// so the hook treats the command as uninspectable; `npm test -- src/*.test.js` is decided by `test`.
// A word right after an option without `=` may be its value and is not counted (fail closed).
export function globDecides(entry, words) {
  let counted = 0;
  let value = false;
  for (const token of entry.tokens?.slice(1) ?? []) {
    if (token.value === '--') break;
    const option = token.value.startsWith('-');
    if (globWord(token) && (option || counted < words)) return true;
    if (option) { value = !token.value.includes('='); continue; }
    if (value) { value = false; continue; }
    counted += 1;
  }
  return false;
}

// An unquoted glob word: `*`, `?`, a bracket expression, or a pattern group. A static word that only
// holds a `[` (the `[` command) is not one.
export function globWord(token) {
  return Boolean(token?.glob) && /[*?(]|\[.+\]/.test(token.value);
}

// The values of a brace sequence body (`1..3`, `a..e..2`, `01..10`), or null when it is not one.
function braceSequence(chars) {
  if (!chars.every(([, unquoted]) => unquoted)) return null;
  const match = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/.exec(chars.map(([character]) => character).join(''));
  if (!match) return null;
  const step = Math.abs(Number(match[5] ?? 1)) || 1;
  let certain = match[5] === undefined || Number(match[5]) !== 0;
  const numeric = match[1] !== undefined;
  const from = numeric ? Number(match[1]) : match[3].charCodeAt(0);
  const to = numeric ? Number(match[2]) : match[4].charCodeAt(0);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return { values: [match[1] ?? match[3]], certain: false };
  const padded = numeric && [match[1], match[2]].some((end) => /^-?0\d/.test(end));
  if (padded && [match[1], match[2]].some((end) => end.startsWith('-'))) certain = false;
  const width = padded ? Math.max(match[1].length, match[2].length) : 0;
  const values = [];
  const direction = from <= to ? 1 : -1;
  for (let value = from; direction > 0 ? value <= to : value >= to; value += direction * step) {
    const sign = value < 0 ? '-' : '';
    values.push(numeric ? sign + String(Math.abs(value)).padStart(width - sign.length, '0') : String.fromCharCode(value));
    if (values.length > SHELL_MAX_BRACE_WORDS) break;
  }
  return { values, certain };
}

// End index (exclusive) of the pattern group whose `(` is at `start`, balanced and past quotes and
// escapes; -1 when unterminated.
function patternGroupEnd(source, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) { if (character === quote) quote = null; else if (character === '\\' && quote === '"') index += 1; continue; }
    if (character === '\\') index += 1;
    else if (character === "'" || character === '"') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')' && --depth === 0) return index + 1;
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
  // Open `( … )` subshells, innermost last: a segment's `scope` is their path.
  const subshells = [];
  let subshellCount = 0;
  // Bash's `{name}` before an operator allocates a descriptor and stores it in name: it leaves the
  // tokens, the operator stays the plain one (`{fd}>out` is `>` to out), and `variable` keeps the name.
  const fdVariable = () => {
    if (!token || token.quoted || token.dynamic || !/^\{[A-Za-z_]\w*\}$/.test(token.value)) return {};
    const variable = token.value.slice(1, -1);
    token = null;
    return { variable };
  };
  const begin = () => { if (!token) token = { value: '', dynamic: false }; };
  // A quote opened at this point of the word: an empty quoted word is not a null word.
  const quoted = () => { token.quoted = true; (token.quotes ??= []).push(token.value.length); };
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
    // Brace expansion, as bash does it before any other expansion: a static word becomes its words
    // (`n{p,x}m` is `npm nxm`). A word also known only at run time, a redirection target with several
    // words, more than SHELL_MAX_BRACE_WORDS words, or a form not known for certain stays one dynamic
    // word whose `bare` text is the first expansion (a word over SHELL_MAX_BRACE_LENGTH keeps its text).
    // An assignment (`x={a,b}`) is not expanded.
    const unquoted = new Set(token.unquoted);
    const quotes = new Set(token.quotes);
    // Cuts are in order and do not overlap, so one pass drops them.
    const cuts = token.cuts ?? [];
    const chars = [];
    for (let position = 0, next = 0; position <= token.value.length; position += 1) {
      while (next < cuts.length && cuts[next][1] <= position) next += 1;
      const [from, to] = cuts[next] ?? [Infinity, Infinity];
      if (quotes.has(position) && !(position > from && position < to)) chars.push(['', false]);
      if (position < token.value.length && !(position >= from && position < to)) chars.push([token.value[position], unquoted.has(position)]);
    }
    const assignment = !redirect && SHELL_ASSIGNMENT.test(token.value) && tokens.every((word) => SHELL_ASSIGNMENT.test(word.value));
    const braces = !token.braces || assignment ? null
      : chars.length > SHELL_MAX_BRACE_LENGTH ? { words: [chars.map(([character]) => character).join('')], kept: [true], certain: false }
        : braceExpand(chars);
    // Bash removes an unquoted null word (`{,npm} publish` runs `npm publish`).
    const words = braces ? braces.words.filter((word, position) => braces.kept[position]) : [chars.map(([character]) => character).join('')];
    const { glob } = token;
    const split = braces && !token.dynamic && braces.certain && braces.words.length <= SHELL_MAX_BRACE_WORDS && (!redirect || words.length === 1);
    let pushed = [token];
    if (split) pushed = words.map((value) => ({ value, dynamic: false, ...(glob ? { glob } : {}) }));
    else if (braces && (braces.words.length > 1 || !braces.certain || token.dynamic)) {
      token.dynamic = true;
      token.bare = words.join(' ');
    } else if (token.cuts) token.bare = words[0];
    // `bare` is a dynamic token's value with its run-time text removed (`n${x}pm` is `npm`); a glob word's
    // lists what it may match, and `wild` marks one that may match anything.
    for (const word of pushed) {
      if (globWord(word)) {
        const matches = globAlternatives(word.bare ?? word.value);
        word.bare = matches.words.join(' ');
        if (matches.wild) word.wild = true;
      }
      delete word.braces; delete word.quoted; delete word.cuts; delete word.unquoted; delete word.quotes;
    }
    if (redirect) { redirections.push({ operator: redirect, target: pushed[0], ...redirectVariable }); redirect = null; } else tokens.push(...pushed);
    token = null;
  };
  const pushSegment = (operator) => {
    pushToken();
    if (redirect) return false;
    if (tokens.length || redirections.length) segments.push({ tokens, operator, redirections, substitutions, scope: subshells.join('/') });
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
    } else if (character === "'" || character === '"') { begin(); quoted(); quote = character; }
    else if (character === '\\') { begin(); if (++index >= source.length) return { error: 'trailing escape' }; token.value += source[index]; }
    else if (character === '$' && source[index + 1] === "'") {
      // `$'…'` is a quoted fragment of the word, decoded; one not known for certain is run-time text.
      const ansi = ansiCString(source, index);
      if (!ansi) return { error: 'unterminated quote' };
      begin(); quoted();
      if (ansi.value === null) unknown(source.slice(index, ansi.end)); else token.value += ansi.value;
      index = ansi.end - 1;
    } else if (character === '$' && source[index + 1] === '"') {
      // `$"…"` is translated through the locale's message catalog at run time: the word is dynamic, and
      // its source text is kept for a hook's text match.
      begin(); quoted(); token.dynamic = true; quote = '"'; index += 1;
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
    } else if (character === '(' && token && !/[ \t]*\)/y.test(source.slice(index + 1, index + 64))
      && !(SHELL_RESERVED.has(token.value) && tokens.every((word) => SHELL_PREFIX_KEYWORDS.has(word.value)))) {
      // `(` glued to word text is a pattern group of that word: bash extglob `@(…)`, `+(…)`, `*(…)`,
      // `?(…)`, `!(…)`, zsh `n(p|x)m` and qualifiers `*(.)`, or zsh `=(…)`, which runs its text like
      // `<(…)`. The word is a dynamic glob; its `bare` text lists the group's alternatives. A
      // reserved word where a command starts (`if(true)`, `!(cmd)`) is followed by a subshell instead.
      const end = patternGroupEnd(source, index);
      if (end < 0) return { error: 'unterminated pattern group' };
      const group = source.slice(index, end);
      if (token.value === '=') substitutions.push(group.slice(1, -1));
      else if (!scanSubstitutions(group, substitutions)) return { error: 'unterminated expansion' };
      token.value += group; token.dynamic = true; token.glob = true;
      index = end - 1;
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
      // A subshell's function definitions end with it. ponytail: a `case` pattern's `)` also closes one,
      // so a definition after it may reach the outer scope; that only widens what a later call runs.
      if (operator === '(') subshells.push(`p${++subshellCount}`);
      else if (operator === ')') subshells.pop();
    } else {
      begin();
      (token.unquoted ??= []).push(token.value.length);
      token.value += character;
      if (character === '{') token.braces = true;
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
    // A glob executable is a file name known only at run time, which may spell any command (`n[p]m`):
    // it is ambiguous and relevant to every hook.
    if (globWord(executable)) return [{ ambiguous: true, relevant: true, glob: true, wrappers }];
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
  if (!options.functions) options = { ...options, functions: new Map(), scopes: { count: 0 } };
  const { functions } = options;
  // Definitions are visible in their own scope and the subshells inside it (`a/p1` sees `a`).
  const visible = (name, scope) => functions.get(name)?.findLast((definition) => !definition.scope || scope === definition.scope || scope.startsWith(`${definition.scope}/`));
  if (Buffer.byteLength(command, 'utf8') > SHELL_MAX_COMMAND_BYTES) return { error: 'command exceeds analysis limit', commands: [] };
  const lexed = lexShell(command, options);
  if (lexed.error) return { error: lexed.error, commands: [] };
  const commands = [];
  const loops = new Map();
  const isWord = (token, value) => Boolean(token) && !token.dynamic && token.value === value;
  let header = null;
  let body = null;
  for (const segment of lexed.segments) {
    const scope = [options.scope ?? '', segment.scope].filter(Boolean).join('/');
    if (segment.operator === '()') { header = { name: segment.tokens.at(-1).value, scope }; continue; }
    if (!body) {
      const [first, name, open] = segment.tokens.slice(segment.tokens.findIndex((token) => token.dynamic || !SHELL_PREFIX_KEYWORDS.has(token.value)));
      // `function name` then newlines, then `{`: the header waits for its body like `name()`.
      if (isWord(first, 'function') && name && !name.dynamic && !open && segment.operator === '\n') { header = { name: name.value, scope }; continue; }
      if (header && isWord(segment.tokens[0], '{')) body = { ...header, depth: 0, commands: [] };
      else if (isWord(first, 'function') && name && !name.dynamic && isWord(open, '{')) {
        body = { name: name.value, scope, depth: 0, commands: [] };
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
    // A substitution runs in a subshell of its own; a nested shell or eval shares this scope (its
    // definitions may reach later commands, which only widens what they run).
    const local = { ...options, scope };
    for (const text of segment.substitutions) {
      const child = { ...options, scope: `${scope}/s${++options.scopes.count}` };
      const nested = depth >= SHELL_MAX_DEPTH ? { error: 'too deep' } : parseShellCommands(text, depth + 1, wrappers, child);
      const inner = nested.error ? [{ ambiguous: true, wrappers: [...wrappers], segment: segment.tokens }] : nested.commands;
      if (inner.length) inner.at(-1).operator = ';';
      output.push(...inner);
    }
    let entries = unwrapCommand(segment.tokens, depth, wrappers, local, segment.redirections)
      .flatMap((entry) => {
        const definition = entry.tokens?.length && !entry.tokens[0].dynamic && visible(entry.tokens[0].value, scope);
        return definition && entry.wrappers.slice(wrappers.length).every((wrapper) => SHELL_FUNCTION_WRAPPERS.has(wrapper))
          ? definition.commands.map((call) => ({ ...call }))
          : [entry];
      });
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
        // A glob argument that may match anything may be any word the hook looks for.
        if (entry.segment.some((token) => token.wild)) entry.relevant = true;
      }
    }
    output.push(...entries);
    if (body && body.depth <= 0) {
      functions.set(body.name, [...(functions.get(body.name) ?? []), { scope: body.scope, commands: body.commands }]);
      body = null;
    }
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
    if (token.dynamic || token.placeholder || globWord(token)) return { ambiguous: true };
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
  if (subcommand.dynamic || subcommand.placeholder || globWord(subcommand)) return { ambiguous: true };
  return { name: subcommand.value.toLowerCase(), index, args: tokens.slice(index + 1), globals, scoped };
}
// </youdede:shared>

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_COMMAND_BYTES = SHELL_MAX_COMMAND_BYTES;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by foreground-process-guard [' + ruleId + ']: ' + detail + '.' }; }

export function collectContext() { return {}; }

// Patterns match one normalized command: the executable's base name followed by its arguments.
function isIndefinite(text) {
  return /\b(?:npm|pnpm|yarn|bun)\b(?:\s+--?[\w-]+(?:=\S+|\s+\S+)?)*\s+(?:run\s+)?(?:dev|start|serve|watch)(?=\s|$)/i.test(text)
    || /(?:^|[|]\s*|\bnpx\s+|\bbunx\s+|\bpnpm\s+(?:dlx|exec)\s+)(?:vite(?!\s+(?:build|optimize)\b)(?:\s|$)|next\s+(?:dev|start)\b|webpack(?:-dev-server|\s+serve)\b|rollup\b[^|;\n]*(?:--watch|-w)\b|tsc\b[^|;\n]*(?:--watch|-w)\b)/i.test(text)
    || /\b(?:nodemon|watchexec|entr)\b|\btail\s+(?:[^|;\n]*\s)?-f\b|\bjournalctl\b[^|;\n]*\s-f\b/i.test(text)
    || /\bpython(?:3)?\s+-m\s+http\.server\b|\brails\s+(?:server|s)\b|\buvicorn\s+\S+|\bgunicorn\s+\S+/i.test(text)
    || /\bdocker(?:\s+compose|-compose)\s+up\b(?![^|;\n]*\s-d\b)|\bkubectl\s+port-forward\b/i.test(text)
    || /^(?:node|nodejs|bun|tsx|ts-node)(?:\s+-\S+)*\s+(?:\S*\/)?server\.[cm]?[jt]s(?:\s|$)/i.test(text)
    || /^go\s+run\s+(?:-\S+\s+)*\S*server\S*(?:\s|$)/i.test(text)
    || /^(?:flask\s+run|cargo\s+watch|php\s+artisan\s+serve|ng\s+serve|hugo\s+serve(?:r)?|jekyll\s+serve)(?:\s|$)|\bmanage\.py\s+runserver\b/i.test(text);
}
function isBounded(entry, text) {
  if (entry.operator === '&' || entry.wrappers.includes('timeout')) return true;
  if (/^(?:gtimeout)\s+(?:--?\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+/i.test(text)) return true;
  if (/^(?:tmux\s+(?:new-session|new)\b[^\n]*\s-d\b|screen\s+-[^\s]*d[^\s]*\b|systemd-run\b|Start-Job\b|Start-Process\b)/i.test(text)) return true;
  return /(?:^|\s)(?:--help|--version|-h|-V)(?:\s|$)/.test(text);
}
export function evaluate(input) {
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_name) return block('foreground-process-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Bash|PowerShell)$/.test(input.tool_name)) return allow();
  // Claude Code's own background boundary.
  if (input.tool_input?.run_in_background === true) return allow();
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return block('foreground-process-input-invalid', 'the shell command is missing');
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) return block('foreground-command-uninspectable', 'the process command exceeds the bounded inspection limit');
  const parsed = parseShellCommands(command);
  if (parsed.error) return block('foreground-command-uninspectable', 'the process command has an unterminated quoted segment or expansion');
  for (const entry of parsed.commands) {
    if (entry.ambiguous) {
      if (entry.relevant || isIndefinite(command)) return block('foreground-command-uninspectable', 'a dynamic process command cannot be proven bounded');
      continue;
    }
    const text = [executableName(entry.tokens[0]), ...entry.tokens.slice(1).map((token) => token.value)].join(' ');
    if (!isIndefinite(text)) continue;
    if (entry.tokens.some((token) => token.dynamic && /`|\$\(|\$\{/.test(token.value))) return block('foreground-command-uninspectable', 'a dynamic process command cannot be proven bounded');
    if (!isBounded(entry, text)) return block('indefinite-foreground-process', 'a recognizable server, watcher, or follow process lacks a timeout or detached boundary');
  }
  return allow();
}

async function receiveEnvelope() {
  const chunks = []; let received = 0;
  for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); }
  try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; }
  catch { throw new Error('hook input is not valid JSON'); }
}
async function runHook() {
  let result;
  try { const input = await receiveEnvelope(); result = evaluate(input); }
  catch (error) { result = block('foreground-process-input-invalid', error.message); }
  if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
