#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// <youdede:shared shell-items>
// Shell command model for Youdede Bash hooks (shared block `shell-items`). `parseShell(command)` reads
// a Bash command the way Bash splits it and returns the items it would run, in order: a Command, an
// Unseen program (text the call runs but does not contain), or a Limit (a bound of this analysis). It
// records facts and simulates nothing. Edit it here and run `npm run shared-hooks`;
// tests/shared-hook-items.test.mjs holds its contract. Nothing is executed, every loop advances or is
// capped, and nesting stops at depth 3.

export const SHELL_ITEMS_MAX_BYTES = 256 * 1024;
const ITEMS_MAX_DEPTH = 3;
const ITEMS_MAX_WRAPPERS = 16;
const ITEMS_MAX_BRACE_WORDS = 64;
const ITEMS_MAX_BRACE_LENGTH = 1024;
// Readings of one simple command (unknown wrapper options read both ways, loop words): past this, a Limit.
const ITEMS_MAX_ALTERNATIVES = 64;
// Function body items expanded at call sites over the whole call: past this, a Limit.
const ITEMS_MAX_CALL_ITEMS = 4096;

// K. Command key: basename, lowercased, cut at the first `.`, trailing digits removed.
export function commandKey(text) {
  const base = String(text).replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  return base.split('.')[0].replace(/\d+$/, '') || base;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const WRAPPERS = new Set(['exec', 'time', 'noglob', 'command', 'builtin', 'env', 'sudo', 'doas', 'setsid', 'nohup', 'nice', 'timeout', 'xargs',
  'stdbuf', 'ionice', 'chrt', 'taskset', 'flock', 'caffeinate', 'unbuffer', 'chronic']);
// Wrappers whose first word after the options is a duration, priority, CPU mask, or lock file.
const WRAPPER_POSITIONAL = new Set(['timeout', 'chrt', 'taskset', 'flock']);
// Wrappers after which a shell still looks up its functions (bash and zsh `time`, zsh `noglob`, zsh `exec`).
const FUNCTION_WRAPPERS = new Set(['time', 'noglob', 'exec']);
// Wrapper options: `next` takes the following word, `alone` stands alone or carries its value, `chdir`
// takes a directory and changes it, `none` runs no given command. Any other option is read both ways.
const WRAPPER_OPTIONS = {
  sudo: {
    next: /^(?:-u|-g|-h|-p|-C|-T|-r|-t|-U)$/,
    alone: /^(?:-[AbEHKnPSilsv]+|--(?:askpass|background|preserve-env|edit|set-home|remove-timestamp|reset-timestamp|non-interactive|stdin|validate|login|shell)|--(?:user|group|host|prompt|close-from|command-timeout|role|type|other-user|preserve-env)=.+)$/,
    chdir: /^(?:-D|--chdir|-R|--chroot)$/,
    chdirJoined: /^(?:-D.+|--chdir=.+|-R.+|--chroot=.+)$/
  },
  doas: { next: /^-u$/, alone: /^-n$/, none: /^-[CsL]/ },
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
  chrt: { next: /^(?:-T|-P|-D|--sched-runtime|--sched-period|--sched-deadline)$/, alone: /^(?:-[bfiordaRmv]+|--(?:batch|fifo|idle|other|rr|deadline|all-tasks|reset-on-fork|verbose))$/ },
  taskset: { alone: /^(?:-[ac]+|--(?:all-tasks|cpu-list))$/ },
  flock: { next: /^(?:-w|-E|--timeout|--wait|--conflict-exit-code)$/, alone: /^(?:-[sxenuoF]+|-[wE].+|--(?:shared|exclusive|nonblock|nb|unlock|close|no-fork|verbose)|--(?:timeout|wait|conflict-exit-code)=.+)$/ },
  caffeinate: { next: /^-[tw]$/, alone: /^-[dimsu]+$/ },
  nice: { next: /^(?:-n|--adjustment)$/, alone: /^(?:-n.+|--adjustment=.+|-[-+]?\d+)$/ },
  timeout: { next: /^(?:-s|-k|--signal|--kill-after)$/, alone: /^(?:-s.+|-k.+|--signal=.+|--kill-after=.+|-v|--verbose|-f|--foreground|-p|--preserve-status)$/ },
  env: { next: /^(?:-u|--unset|-a|--argv0)$/, alone: /^(?:-u.+|--unset=.+|-a.+|--argv0=.+|-i|--ignore-environment|-0|--null|-v|--debug|-)$/, chdir: /^(?:-C|--chdir)$/, chdirJoined: /^(?:-C.+|--chdir=.+)$/ },
  xargs: {
    next: /^(?:-[ILnPdEsaJRS]|--(?:arg-file|delimiter|max-lines|max-args|max-procs|max-chars|process-slot-var))$/,
    alone: /^(?:-[0rtpxo]+|-[ILnPdEsaJRS].+|-[ie].*|-l\d*|--(?:null|no-run-if-empty|verbose|interactive|exit|open-tty|show-limits|replace)|--(?:arg-file|delimiter|max-lines|max-args|max-procs|max-chars|process-slot-var|replace|eof)=.*)$/
  }
};
const POWERSHELL_VALUE_OPTIONS = /^-(?:ex|ep|executionpolicy|inp|if|inputformat|o|of|outputformat|w|windowstyle|wd|workingdirectory|config|configurationname|v|version|settings|settingsfile|custompipename)$/;
const POWERSHELL_FLAGS = /^-(?:nop|noprofile|nol|nologo|noni|noninteractive|noe|noexit|sta|mta|l|login|i|interactive)$/;
// Clients that fetch from the network: an unseen program they produce is `network` (only the rule id
// depends on this list; every other producer is refused as well unless allowlisted).
export const NETWORK_PRODUCERS = new Set(['curl', 'wget', 'fetch', 'aria2c', 'http', 'https', 'xh', 'nc', 'ncat', 'socat', 'ssh', 'gh', 'lynx', 'links']);
// Reviewed allowlist of shell setup output: `TOOL init|env|shellenv|hook|activate`,
// `ssh-agent`, and any `… completion[s] …` as the first or second operand.
const SETUP_TOOLS = new Set(['pyenv', 'rbenv', 'nodenv', 'jenv', 'goenv', 'fnm', 'starship', 'direnv', 'zoxide', 'mise', 'brew', 'conda', 'atuin']);
const SETUP_VERBS = new Set(['init', 'env', 'shellenv', 'hook', 'activate']);
// Prefix words run the command after them; closers end a compound command.
const PREFIX_WORDS = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', 'nocorrect', '-']);
const CLOSERS = new Set(['}', 'fi', 'done', 'esac']);
const OPENERS = new Set(['{', 'if', 'while', 'until', 'for', 'select', 'case', 'foreach', 'repeat']);
const DIRECTORY_CHANGERS = new Set(['cd', 'pushd', 'popd']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

// ---- lexer --------------------------------------------------------------------------------------

// End (exclusive) of the expansion at `start`: `$name`, `${…}`, `$(…)`, `$((…))`, a backtick block, or
// `<(…)`/`>(…)`; -1 when unterminated. Here-document bodies inside `$(…)` are skipped as data.
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

// The command texts an expansion runs: `$(…)`, backticks, `<(…)`/`>(…)`, and those inside `${…}` and
// `$((…))`. False when one is unterminated.
function expansionCommands(text, found) {
  if (text.startsWith('`')) { found.push(text.slice(1, -1).replace(/\\([\\`$])/g, '$1')); return true; }
  if (text.startsWith('$((')) return textCommands(text.slice(3, -2), found);
  if (/^(?:\$|<|>)\(/.test(text)) { found.push(text.slice(2, -1)); return true; }
  if (text.startsWith('${')) return textCommands(text.slice(2, -1), found, true);
  return true;
}
// Substitutions in free text (an expanded here-document body, `$((…))`, `${…}`, `[[ … ]]`).
function textCommands(text, found, processSubstitutions = false) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== "'" && character === '\\') { index += 1; continue; }
    if (processSubstitutions && (character === "'" || character === '"') && (!quote || quote === character)) { quote = quote ? null : character; continue; }
    const substitution = processSubstitutions && !quote && (character === '<' || character === '>') && text[index + 1] === '(';
    if (character !== '$' && character !== '`' && !substitution) continue;
    const end = expansionEnd(text, index);
    if (end < 0 || !expansionCommands(text.slice(index, end), found)) return false;
    index = end - 1;
  }
  return true;
}

function isHeredocStart(source, index) {
  return source[index] === '<' && source[index + 1] === '<' && source[index + 2] !== '<';
}
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
  return { delimiter, quoted, stripTabs, end: cursor, body: '' };
}
// Reads the bodies of `heredocs`, in order, from `position`; a body without its delimiter line runs to
// the end, as in bash. Returns the index after the last delimiter line.
function skipHeredocBodies(source, position, heredocs) {
  for (const heredoc of heredocs) {
    while (position < source.length) {
      let lineEnd = source.indexOf('\n', position);
      if (lineEnd < 0) lineEnd = source.length;
      const line = source.slice(position, lineEnd);
      position = lineEnd + 1;
      if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
      heredoc.body += `${heredoc.stripTabs ? line.replace(/^\t+/, '') : line}\n`;
    }
  }
  return Math.min(position, source.length);
}

// ANSI-C `$'…'` at `start`: { end, value }, value null when an escape is not decoded with certainty.
const ANSI_C_ESCAPES = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
function ansiC(source, start) {
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
    } else if (escape in ANSI_C_ESCAPES) { value += ANSI_C_ESCAPES[escape]; index += 1; }
    else { certain = false; index += 1; }
  }
  return null;
}

// End (exclusive) of the balanced group whose `(` is at `start`, past quotes and escapes; -1 unterminated.
function groupEnd(source, start) {
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

// Tokens: words ({ type: 'word', pieces, raw, commands }), operators ({ type: 'op', op }), redirections
// ({ type: 'redirect', op, fd, variable, target, heredoc }), and data blocks ({ type: 'data', commands }:
// `[[ … ]]`, `(( … ))`). A word's pieces: { c, q } characters (q: quoted), { exp, q } expansions,
// { group } glob groups, { opaque } locale strings or undecoded escapes. `commands` lists the command
// texts its substitutions run.
function lex(source) {
  const tokens = [];
  let word = null;
  let redirect = null;
  let heredocs = [];
  const atStart = () => {
    const last = tokens.at(-1);
    return !last || last.type === 'op' || (last.type === 'word' && (PREFIX_WORDS.has(staticRaw(last)) || ['for', 'select', 'time'].includes(staticRaw(last))));
  };
  const begin = () => { word ??= { type: 'word', pieces: [], raw: '', commands: [], start: index }; };
  const pushWord = () => {
    if (!word) return;
    word.raw = source.slice(word.start, index);
    if (redirect) { redirect.target = word; tokens.push(redirect); redirect = null; } else tokens.push(word);
    word = null;
  };
  const expansion = (quoted) => {
    const end = expansionEnd(source, index);
    if (end < 0 || !expansionCommands(source.slice(index, end), word.commands)) return false;
    const text = source.slice(index, end);
    word.pieces.push({ exp: text, q: quoted, procsub: /^[<>]\(/.test(text) });
    index = end - 1;
    return true;
  };
  let index = 0;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\' && source[index + 1] === '\n') { index += 1; continue; }
    if (/\s/.test(character)) {
      pushWord();
      if (character !== '\n') continue;
      if (redirect) return { error: 'redirection without target' };
      tokens.push({ type: 'op', op: '\n' });
      if (heredocs.length) {
        const pending = heredocs.splice(0);
        index = skipHeredocBodies(source, index + 1, pending) - 1;
        for (const heredoc of pending) if (!heredoc.quoted && !textCommands(heredoc.body, heredoc.commands)) return { error: 'unterminated expansion' };
      }
      continue;
    }
    // `[[ … ]]` and `(( … ))` where a command starts are data; only their substitutions run.
    if (!word && !redirect && atStart() && (source.startsWith('[[', index) && /[\s]/.test(source[index + 2] ?? '')
      || source.startsWith('((', index))) {
      const arithmetic = source[index] === '(';
      let end = -1;
      if (arithmetic) {
        const close = groupEnd(source, index);
        end = close > 0 && source[close - 2] === ')' ? close : -1;
      } else {
        const match = /(?:^|\s)\]\](?=$|[\s;&|)])/.exec(source.slice(index + 2));
        end = match ? index + 2 + match.index + match[0].length : -1;
      }
      if (end > 0) {
        const commands = [];
        if (!textCommands(source.slice(index + 2, arithmetic ? end - 2 : end - 2), commands)) return { error: 'unterminated expansion' };
        tokens.push({ type: 'data', commands });
        index = end - 1;
        continue;
      }
    }
    if (character === "'") {
      begin();
      const close = source.indexOf("'", index + 1);
      if (close < 0) return { error: 'unterminated quote' };
      const text = source.slice(index + 1, close);
      if (!text) word.pieces.push({ c: '', q: true });
      for (const item of text) word.pieces.push({ c: item, q: true });
      index = close;
      continue;
    }
    if (character === '"' || (character === '$' && source[index + 1] === '"')) {
      begin();
      const locale = character === '$';
      if (locale) { index += 1; word.pieces.push({ opaque: '$"' }); }
      let closed = false;
      let empty = true;
      for (index += 1; index < source.length; index += 1) {
        const inner = source[index];
        if (inner === '"') { closed = true; break; }
        empty = false;
        if (inner === '\\') {
          index += 1;
          if (index >= source.length) return { error: 'trailing escape' };
          if (!'$`"\\\n'.includes(source[index])) word.pieces.push({ c: '\\', q: true });
          if (source[index] !== '\n') word.pieces.push({ c: source[index], q: true });
        } else if (inner === '$' || inner === '`') {
          if (!expansion(true)) return { error: 'unterminated expansion' };
        } else word.pieces.push({ c: inner, q: true });
      }
      if (!closed) return { error: 'unterminated quote' };
      if (empty) word.pieces.push({ c: '', q: true });
      continue;
    }
    if (character === '\\') {
      begin();
      if (index + 1 >= source.length) return { error: 'trailing escape' };
      word.pieces.push({ c: source[++index], q: true });
      continue;
    }
    if (character === '$' && source[index + 1] === "'") {
      begin();
      const decoded = ansiC(source, index);
      if (!decoded) return { error: 'unterminated quote' };
      if (decoded.value === null) word.pieces.push({ opaque: source.slice(index, decoded.end) });
      else if (!decoded.value) word.pieces.push({ c: '', q: true });
      else for (const item of decoded.value) word.pieces.push({ c: item, q: true });
      index = decoded.end - 1;
      continue;
    }
    if (character === '$' || character === '`' || ((character === '<' || character === '>') && source[index + 1] === '(')) {
      begin();
      if (!expansion(false)) return { error: 'unterminated expansion' };
      continue;
    }
    if (isHeredocStart(source, index)) {
      const heredoc = readHeredoc(source, index);
      if (!heredoc) return { error: 'redirection without target' };
      let fd = '';
      let variable = null;
      const raw = word ? source.slice(word.start, index) : '';
      if (word && /^\d+$/.test(raw) && word.pieces.every((piece) => piece.q === false)) { fd = raw; word = null; }
      else if (word && /^\{[A-Za-z_]\w*\}$/.test(raw)) { variable = raw.slice(1, -1); word = null; }
      pushWord();
      if (redirect) return { error: 'redirection without target' };
      heredoc.commands = [];
      tokens.push({ type: 'redirect', op: heredoc.stripTabs ? '<<-' : '<<', fd, variable, target: null, heredoc });
      heredocs.push(heredoc);
      index = heredoc.end - 1;
      continue;
    }
    if (character === '<' || character === '>' || (character === '&' && source[index + 1] === '>')) {
      let fd = '';
      let variable = null;
      if (character !== '&' && word) {
        const raw = source.slice(word.start, index);
        if (/^\d+$/.test(raw) && word.pieces.every((piece) => piece.q === false)) { fd = raw; word = null; }
        else if (/^\{[A-Za-z_]\w*\}$/.test(raw)) { variable = raw.slice(1, -1); word = null; }
      }
      pushWord();
      if (redirect) return { error: 'redirection without target' };
      let op = character;
      if (character === '&') { op = '&>'; index += 1; if (source[index + 1] === '>') { op += '>'; index += 1; } }
      else {
        const next = source[index + 1];
        if (next === character) {
          op += next; index += 1;
          if (character === '<' && source[index + 1] === '<') { op += '<'; index += 1; }
        } else if (next === '&' || next === '|' || (character === '<' && next === '>')) { op += next; index += 1; }
      }
      redirect = { type: 'redirect', op, fd, variable, target: null, heredoc: null };
      continue;
    }
    if (character === '(' && word && !redirect && ASSIGNMENT.test(source.slice(word.start, index)) && source[index - 1] === '=') {
      // `name=( … )`: array elements are data; only their substitutions run.
      const end = groupEnd(source, index);
      if (end < 0) return { error: 'invalid array' };
      if (!textCommands(source.slice(index + 1, end - 1), word.commands, true)) return { error: 'unterminated expansion' };
      word.pieces.push({ exp: source.slice(index, end), q: true });
      index = end - 1;
      continue;
    }
    if (character === '(' && word && !/[ \t]*\)/y.test(source.slice(index + 1, index + 64))) {
      // `(` glued to word text: a glob group (`@(…)`, `!(…)`, zsh `n(p|x)m`), or zsh `=(…)`.
      const end = groupEnd(source, index);
      if (end < 0) return { error: 'unterminated pattern group' };
      const group = source.slice(index, end);
      if (source.slice(word.start, index) === '=') word.commands.push(group.slice(1, -1));
      else if (!textCommands(group, word.commands)) return { error: 'unterminated expansion' };
      const last = word.pieces.at(-1);
      if (last && last.q === false && '@*+?!'.includes(last.c)) word.pieces.pop();
      word.pieces.push({ group });
      index = end - 1;
      continue;
    }
    if (';&|()'.includes(character)) {
      pushWord();
      if (redirect) return { error: 'redirection without target' };
      let op = character;
      const next = source[index + 1];
      if (character === ';' && next === ';') { op = ';;'; index += 1; if (source[index + 1] === '&') { op = ';;&'; index += 1; } }
      else if (character === ';' && next === '&') { op = ';&'; index += 1; }
      else if ((character === '&' || character === '|') && next === character) { op += next; index += 1; }
      else if (character === '|' && next === '&') { op = '|&'; index += 1; }
      tokens.push({ type: 'op', op });
      continue;
    }
    begin();
    word.pieces.push({ c: character, q: false });
  }
  pushWord();
  if (redirect) return { error: 'redirection without target' };
  // A body left without its delimiter runs to the end; its substitutions still count.
  for (const heredoc of heredocs) if (!heredoc.quoted && !textCommands(heredoc.body, heredoc.commands)) return { error: 'unterminated expansion' };
  return { tokens };
}

function staticRaw(token) {
  return token?.type === 'word' && token.pieces.every((piece) => piece.c !== undefined && piece.q === false) ? token.raw : null;
}

// ---- words --------------------------------------------------------------------------------------

// Bash brace expansion over pieces: comma lists and sequences of unquoted literal characters.
// Returns { words, certain } (words of pieces); past ITEMS_MAX_BRACE_WORDS results, null.
function braceExpand(pieces, out = { words: [], certain: true }) {
  const active = (piece, character) => piece.q === false && piece.c === character;
  for (let open = 0; open < pieces.length; open += 1) {
    if (!active(pieces[open], '{')) continue;
    let depth = 0;
    let close = -1;
    const commas = [];
    for (let index = open; index < pieces.length && close < 0; index += 1) {
      if (active(pieces[index], '{')) depth += 1;
      else if (active(pieces[index], '}') && --depth === 0) close = index;
      else if (active(pieces[index], ',') && depth === 1) commas.push(index);
    }
    if (close < 0) continue;
    let alternatives = null;
    if (commas.length) {
      const bounds = [open, ...commas, close];
      alternatives = bounds.slice(1).map((end, position) => pieces.slice(bounds[position] + 1, end));
    } else {
      const sequence = braceSequence(pieces.slice(open + 1, close));
      if (sequence) {
        out.certain &&= sequence.certain;
        alternatives = sequence.values.map((value) => [...value].map((c) => ({ c, q: true })));
      }
    }
    if (!alternatives) continue;
    for (const alternative of alternatives) {
      if (out.words.length > ITEMS_MAX_BRACE_WORDS) break;
      braceExpand([...pieces.slice(0, open), ...alternative, ...pieces.slice(close + 1)], out);
    }
    return out;
  }
  out.words.push(pieces);
  return out;
}
function braceSequence(pieces) {
  if (!pieces.every((piece) => piece.q === false && piece.c !== undefined)) return null;
  const match = /^(?:(-?\d+)\.\.(-?\d+)|([A-Za-z])\.\.([A-Za-z]))(?:\.\.(-?\d+))?$/.exec(pieces.map((piece) => piece.c).join(''));
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
    if (values.length > ITEMS_MAX_BRACE_WORDS) break;
  }
  return { values, certain };
}

// A bracket expression at `pieces[index]` (`[`): { part, next } or null when it does not close.
const CLASS_RANGES = { alpha: [[65, 90], [97, 122]], digit: [[48, 57]], alnum: [[48, 57], [65, 90], [97, 122]], upper: [[65, 90]], lower: [[97, 122]],
  space: [[9, 13], [32, 32]], punct: [[33, 47], [58, 64], [91, 96], [123, 126]], xdigit: [[48, 57], [65, 70], [97, 102]], word: [[48, 57], [65, 90], [95, 95], [97, 122]] };
function bracket(pieces, index) {
  let cursor = index + 1;
  const negated = pieces[cursor]?.q === false && (pieces[cursor].c === '!' || pieces[cursor].c === '^');
  if (negated) cursor += 1;
  const set = [];
  let first = true;
  for (; cursor < pieces.length; cursor += 1) {
    const piece = pieces[cursor];
    if (piece.c === undefined) return null;
    if (piece.q === false && piece.c === ']' && !first) return { part: { set, negated }, next: cursor + 1 };
    first = false;
    const rest = pieces.slice(cursor, cursor + 12).map((item) => item.c ?? '\0').join('');
    const named = /^\[:(\w+):\]/.exec(rest);
    if (named) {
      // An unknown class matches any character: fail closed.
      set.push(...(CLASS_RANGES[named[1]] ?? [[0, 0x10ffff]]));
      cursor += named[0].length - 1;
      continue;
    }
    const code = piece.c.codePointAt(0);
    if (pieces[cursor + 1]?.c === '-' && pieces[cursor + 2]?.c !== undefined && pieces[cursor + 2].c !== ']') {
      set.push([code, pieces[cursor + 2].c.codePointAt(0)]);
      cursor += 2;
    } else set.push([code, code]);
  }
  return null;
}

// The Word of a piece list: static, pattern (with parts), or opaque.
function toWord(pieces, raw) {
  if (pieces.some((piece) => piece.opaque !== undefined)) return { kind: 'opaque', text: raw };
  const parts = [];
  let splits = false;
  let procsub = false;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (piece.exp !== undefined) {
      parts.push({ any: 'expansion' });
      if (piece.procsub) procsub = true;
      // Word splitting: an unquoted expansion; `"$@"` and `"${a[@]}"` even when quoted.
      if (!piece.procsub && (!piece.q || /^\$(?:@|\{@|\{[^}]*\[@\])/.test(piece.exp))) splits = true;
    } else if (piece.group !== undefined) parts.push({ any: 'glob' });
    else if (piece.q === false && piece.c === '*') parts.push({ any: 'glob' });
    else if (piece.q === false && piece.c === '?') parts.push({ one: true });
    else if (piece.q === false && piece.c === '[' && bracket(pieces, index)) {
      const { part, next } = bracket(pieces, index);
      parts.push(part);
      index = next - 1;
    } else if (piece.c) parts.push({ lit: piece.c });
  }
  if (parts.every((part) => part.lit !== undefined)) return { kind: 'static', text: parts.map((part) => part.lit).join('') };
  const word = { kind: 'pattern', text: raw, parts };
  if (splits) word.splits = true;
  if (procsub && pieces.length === 1) word.procsub = true;
  return word;
}

// A lexed word as the Words it becomes after brace expansion (an assignment is not expanded). An
// unquoted null word is removed; past a cap, or not known for certain, the word is opaque.
function wordsOf(token, assignment = false) {
  const hasBrace = token.pieces.some((piece) => piece.q === false && piece.c === '{');
  if (!hasBrace || assignment) return [toWord(token.pieces, token.raw)];
  if (token.pieces.length > ITEMS_MAX_BRACE_LENGTH) return [{ kind: 'opaque', text: token.raw }];
  const expanded = braceExpand(token.pieces);
  if (!expanded.certain || expanded.words.length > ITEMS_MAX_BRACE_WORDS) return [{ kind: 'opaque', text: token.raw }];
  return expanded.words.filter((pieces) => pieces.length > 0).map((pieces) => toWord(pieces, token.raw));
}

// ---- items --------------------------------------------------------------------------------------

const limit = (reason) => ({ kind: 'limit', reason });
const isStaticWord = (word) => word?.kind === 'static';
const textOf = (word) => (isStaticWord(word) ? word.text : null);

// Items of `text` at `depth`; `context` carries the functions and loop words of the whole call.
function parseText(text, depth, context) {
  if (depth > ITEMS_MAX_DEPTH) return [limit('depth')];
  if (Buffer.byteLength(text, 'utf8') > SHELL_ITEMS_MAX_BYTES) return [limit('size')];
  const lexed = lex(text);
  if (lexed.error) return [limit('syntax')];
  return parseTokens(lexed.tokens, depth, context);
}

// Function definitions are journaled so that those made in a `( … )` group or a substitution end with
// that subshell (a later outer call runs the command, not the body).
function defineFunction(context, name, items) {
  const list = context.functions.get(name);
  context.journal.push([context.functions, name, list ? list.length : -1]);
  if (list) list.push(...items);
  else context.functions.set(name, [...items]);
}
function rollback(context, mark) {
  while (context.journal.length > mark) {
    const [functions, name, length] = context.journal.pop();
    if (length < 0) functions.delete(name);
    else functions.get(name).length = length;
  }
}

// Walks the tokens: compound syntax is read as data, each simple command becomes items after the
// commands of its substitutions, and function bodies are set aside until a call.
function parseTokens(tokens, depth, context) {
  const out = [];
  let sink = out;
  const bodies = [];
  let simple = null;
  let pipeFrom = undefined;
  const cases = [];
  const subshells = [];
  let index = 0;
  const reset = () => { simple = { words: [], redirects: [], commands: [] }; };
  reset();
  // A substitution runs before its command, as if followed by `;`.
  const substitutions = (commands) => {
    for (const commandText of commands) {
      const mark = context.journal.length;
      const inner = parseText(commandText, depth + 1, context);
      rollback(context, mark);
      if (inner.length) inner.at(-1).operator = ';';
      sink.push(...inner);
    }
  };
  // Nesting inside a function body; the body ends when it returns to zero.
  const nest = (delta) => {
    const body = bodies.at(-1);
    if (!body) return;
    body.level += delta;
    if (delta < 0 && body.level <= 0) {
      bodies.pop();
      defineFunction(context, body.name, body.items);
      sink = bodies.at(-1)?.items ?? out;
    }
  };
  // Ends a simple command. `pipeFrom` is the producer of the next command's standard input: the
  // command before `|`, null after a compound command, undefined without a pipe.
  const finish = (op) => {
    const current = simple;
    reset();
    substitutions(current.commands);
    const empty = !current.words.length && !current.redirects.length;
    if (empty && op === '\n') return;
    let producer = null;
    if (!empty) {
      const items = commandItems(current, depth, context, { producer: pipeFrom });
      for (const item of items) item.operator ??= op;
      if (items.length) items.at(-1).operator = op;
      sink.push(...items);
      const own = items.filter((item) => item.kind === 'command' && item.level === depth);
      producer = own.length === 1 && current.words.length ? own[0] : null;
    }
    pipeFrom = op === '|' || op === '|&' ? producer : undefined;
  };
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    const caseState = cases.at(-1);
    if (caseState?.patterns) {
      // Case patterns: data up to `)`; `esac` ends the case.
      if (token.type === 'word') {
        if (caseState.fresh && staticRaw(token) === 'esac') { cases.pop(); nest(-1); continue; }
        caseState.fresh = false;
        substitutions(token.commands);
      } else if (token.type === 'op' && token.op === ')') caseState.patterns = false;
      else if (token.type === 'data') substitutions(token.commands);
      continue;
    }
    if (token.type === 'op') {
      if ([';;', ';&', ';;&'].includes(token.op)) {
        finish(';');
        if (caseState) { caseState.patterns = true; caseState.fresh = true; }
        pipeFrom = undefined;
        continue;
      }
      finish(token.op);
      if (token.op === '(') {
        subshells.push(context.journal.length);
        nest(1);
      } else if (token.op === ')') {
        if (subshells.length) rollback(context, subshells.pop());
        nest(-1);
      }
      continue;
    }
    if (token.type === 'data') { substitutions(token.commands); continue; }
    if (token.type === 'redirect') {
      simple.redirects.push(token);
      if (token.target) simple.commands.push(...token.target.commands);
      if (token.heredoc) simple.commands.push(...token.heredoc.commands);
      continue;
    }
    // A word.
    const raw = staticRaw(token);
    if (!simple.words.length && !simple.redirects.length) {
      if (raw !== null && PREFIX_WORDS.has(raw)) { if (raw === '{' || ['if', 'while', 'until'].includes(raw)) nest(1); continue; }
      if (raw === 'time') { if (staticRaw(tokens[index + 1]) === '-p') index += 1; continue; }
      if (raw !== null && CLOSERS.has(raw)) {
        if (raw === 'esac') cases.pop();
        nest(-1);
        continue;
      }
      if (raw === 'case') {
        const subject = tokens[index + 1];
        if (subject?.type === 'word') substitutions(subject.commands);
        if (staticRaw(tokens[index + 2]) === 'in') {
          cases.push({ patterns: true, fresh: true });
          nest(1);
          index += 2;
          while (tokens[index + 1]?.type === 'op' && tokens[index + 1].op === '\n') index += 1;
          if (tokens[index + 1]?.type === 'op' && tokens[index + 1].op === '(') index += 1;
          continue;
        }
      }
      if (raw === 'for' || raw === 'select' || raw === 'foreach') {
        // `for NAME in WORDS`, zsh `for NAME (WORDS)`, `foreach NAME (WORDS)`: data; NAME stands for
        // each of WORDS in the body (G9). `for ((…))` is a data block.
        nest(1);
        const name = staticRaw(tokens[index + 1]);
        let cursor = index + 2;
        const words = [];
        const parenthesized = tokens[cursor]?.type === 'op' && tokens[cursor].op === '(';
        if (name && (staticRaw(tokens[cursor]) === 'in' || parenthesized)) {
          cursor += 1;
          for (; cursor < tokens.length; cursor += 1) {
            const item = tokens[cursor];
            if (item.type === 'op' || (item.type === 'word' && !parenthesized && staticRaw(item) === 'do')) break;
            if (item.type === 'word') { substitutions(item.commands); words.push(...wordsOf(item)); }
          }
          if (/^[A-Za-z_]\w*$/.test(name)) context.loops.set(name, words);
          index = parenthesized && tokens[cursor]?.op === ')' ? cursor : cursor - 1;
        } else if (name) index += 1;
        continue;
      }
      if (raw === 'function' && staticRaw(tokens[index + 1])) {
        index += 1;
        if (tokens[index + 1]?.type === 'op' && tokens[index + 1].op === '(' && tokens[index + 2]?.op === ')') index += 2;
        startFunction(staticRaw(tokens[index]));
        continue;
      }
      if (raw === 'coproc') {
        const name = staticRaw(tokens[index + 1]);
        const after = tokens[index + 2];
        if (name && /^[A-Za-z_]\w*$/.test(name) && ((after?.type === 'word' && OPENERS.has(staticRaw(after))) || (after?.type === 'op' && after.op === '('))) index += 1;
        continue;
      }
      if (raw === 'repeat') { index += 1; continue; }
      if (raw === 'in') continue;
      // `name ( )` header: remembered until the `(` operator.
      if (raw !== null && /^[A-Za-z_][\w.:-]*$/.test(raw) && tokens[index + 1]?.type === 'op' && tokens[index + 1].op === '(' && tokens[index + 2]?.type === 'op' && tokens[index + 2].op === ')') {
        startFunction(raw);
        index += 2;
        continue;
      }
    }
    simple.words.push(token);
    simple.commands.push(...token.commands);
  }
  finish('');
  // A body left open is a syntax error and nothing runs; its commands are kept (fail closed).
  for (const body of bodies) out.push(...body.items);
  return out;

  function startFunction(name) {
    const body = { name, level: 0, items: [] };
    bodies.push(body);
    sink = body.items;
    // The body is the next compound command; a bare command body closes with its segment.
    let next = index + 1;
    while (tokens[next]?.type === 'op' && tokens[next].op === '\n') next += 1;
    index = next - 1;
    const first = tokens[next];
    if (!(first?.type === 'op' && first.op === '(') && !(first?.type === 'word' && OPENERS.has(staticRaw(first)))) body.level = 0.5;
  }
}

// Loop words (G9): a word that is exactly `$NAME`, `${NAME}`, or `"$NAME"` after `for NAME in WORDS`.
function loopName(token, context) {
  const match = /^"?\$(?:\{(\w+)\}|(\w+))"?$/.exec(token.raw);
  const name = match && (match[1] ?? match[2]);
  return name && context.loops.has(name) ? name : null;
}

// The items of one simple command.
function commandItems(simple, depth, context, pipe) {
  let assignments = [];
  let start = 0;
  for (; start < simple.words.length; start += 1) {
    const token = simple.words[start];
    if (!ASSIGNMENT.test(token.raw) || token.pieces.slice(0, token.raw.indexOf('=') + 1).some((piece) => piece.q !== false || piece.c === undefined)) break;
    const equals = token.raw.indexOf('=');
    const name = token.raw.slice(0, equals).replace(/\+$/, '');
    assignments.push({ name, value: toWord(token.pieces.slice(equals + 1), token.raw.slice(equals + 1)) });
  }
  const tokens = simple.words.slice(start);
  const redirections = simple.redirects.map((redirect) => ({
    operator: redirect.op, fd: redirect.fd, variable: redirect.variable ?? null,
    target: redirect.heredoc ? { kind: 'static', text: redirect.heredoc.delimiter } : wordsOf(redirect.target)[0] ?? { kind: 'static', text: '' },
    // A here-document body is static when its delimiter is quoted or it has no `$`, backtick, or `\`.
    heredoc: redirect.heredoc ? { body: redirect.heredoc.body, static: redirect.heredoc.quoted || !/[$`\\]/.test(redirect.heredoc.body) } : null
  }));
  // Only assignments: nothing runs. Only redirections: a command without an executable.
  if (!tokens.length) {
    return simple.redirects.length ? [command({ exe: null, words: [], wrappers: [], assignments, redirections }, depth, pipe)] : [];
  }
  // Loop words: one reading per word, for the first loop variable used.
  const loopIndex = tokens.findIndex((token) => loopName(token, context));
  let readings = [tokens.flatMap((token) => wordsOf(token))];
  if (loopIndex >= 0) {
    const name = loopName(tokens[loopIndex], context);
    const values = context.loops.get(name);
    if (values.length) {
      readings = values.slice(0, ITEMS_MAX_ALTERNATIVES).map((value) => tokens.flatMap((token) => (loopName(token, context) === name ? [value] : wordsOf(token))));
    }
  }
  const items = [];
  for (const words of readings) items.push(...unwrap({ words, wrappers: [], assignments, redirections, changedDirectory: false }, depth, context, pipe));
  return items;
}

// Builds a Command item.
function command(entry, depth, pipe) {
  const stdin = [...entry.redirections].reverse().find((redirection) => /^(?:0?)$/.test(redirection.fd) && !redirection.variable && /^(?:<|<<|<<-|<<<|<>|<&)$/.test(redirection.operator));
  const stdinFrom = stdin ? (stdin.heredoc ? 'heredoc' : stdin.operator === '<<<' ? 'herestring' : 'file') : pipe.producer !== undefined ? 'pipe' : null;
  return {
    kind: 'command', key: entry.exe && isStaticWord(entry.exe) ? commandKey(entry.exe.text) : null, exe: entry.exe, words: entry.words,
    wrappers: entry.wrappers, assignments: entry.assignments, redirections: entry.redirections, stdinFrom, operator: undefined,
    changedDirectory: entry.changedDirectory, index: 0, producer: pipe.producer ?? null, level: depth
  };
}

// Removes wrappers and follows nested programs. An unknown wrapper option is read both ways; a
// non-static word where an option or the command may stand is read as the command and both ways.
function unwrap(start, depth, context, pipe) {
  const results = [];
  const queue = [{ ...start, count: 0 }];
  let budget = ITEMS_MAX_ALTERNATIVES;
  while (queue.length) {
    // Wrapper readings share the word list and start at `offset`, so a chain of wrappers does not copy
    // the remaining words once per wrapper.
    const { offset = 0, ...entry } = queue.shift();
    if (--budget < 0) return [limit('wrappers')];
    const exe = entry.words[offset];
    if (!exe) continue;
    const rest = () => entry.words.slice(offset + 1);
    if (!isStaticWord(exe)) { results.push(command({ ...entry, exe, words: rest() }, depth, pipe)); continue; }
    const key = commandKey(exe.text);
    if (WRAPPERS.has(key) && !(key === 'command' && /^-[vV]$/.test(textOf(entry.words[offset + 1]) ?? ''))) {
      if (entry.count >= ITEMS_MAX_WRAPPERS) return [limit('wrappers')];
      const forks = wrapperForks(key, exe, entry.words, offset + 1, entry, depth, context, pipe);
      results.push(...forks.items);
      for (const fork of forks.entries) queue.push({ ...fork, count: entry.count + 1 });
      continue;
    }
    results.push(...programItems(key, exe, rest(), entry, depth, context, pipe));
  }
  return results;
}

// The readings after one wrapper: { entries } to keep unwrapping and { items } that end here.
function wrapperForks(name, exe, words, offset, entry, depth, context, pipe) {
  const options = WRAPPER_OPTIONS[name] ?? {};
  const wrappers = [...entry.wrappers, name];
  const forks = [];
  // Walk the options; `branches` are the readings still open: { index, changedDirectory, replace }.
  let branches = [{ index: offset, changedDirectory: entry.changedDirectory, replace: null, assignments: entry.assignments, split: null }];
  const done = [];
  for (let guard = 0; branches.length && guard < words.length + 2; guard += 1) {
    const next = [];
    for (const branch of branches) {
      const word = words[branch.index];
      if (!word) { done.push({ ...branch, empty: true }); continue; }
      if (!isStaticWord(word)) {
        // `env NAME=$VALUE`: an assignment whose value is known only at run time.
        const literal = word.kind === 'pattern' ? /^[^]*?(?==|$)/.exec(word.parts.map((part) => part.lit ?? '\0').join(''))[0] : '';
        if (name === 'env' && ASSIGNMENT.test(`${literal}=`) && !literal.includes('\0') && word.parts[literal.length]?.lit === '=') {
          next.push({ ...branch, index: branch.index + 1, assignments: [...branch.assignments, { name: literal.replace(/\+$/, ''), value: { kind: 'pattern', text: word.text.slice(word.text.indexOf('=') + 1), parts: word.parts.slice(literal.length + 1) } }] });
          continue;
        }
        // The command itself, or an option standing alone, or one taking the next word.
        done.push(branch);
        next.push({ ...branch, index: branch.index + 1 }, { ...branch, index: branch.index + 2 });
        continue;
      }
      const text = word.text;
      if (text === '--') { done.push({ ...branch, index: branch.index + 1 }); continue; }
      if (name === 'env' && ASSIGNMENT.test(text)) {
        const equals = text.indexOf('=');
        next.push({ ...branch, index: branch.index + 1, assignments: [...branch.assignments, { name: text.slice(0, equals).replace(/\+$/, ''), value: { kind: 'static', text: text.slice(equals + 1) } }] });
        continue;
      }
      if (!text.startsWith('-') || text === '-' && name !== 'env') { done.push(branch); continue; }
      if (name === 'env' && /^(?:-S|--split-string)(?:=|$)/.test(text) || (name === 'env' && /^-S./.test(text))) {
        const joined = /^(?:-S|--split-string=)(.+)$/.exec(text);
        const value = joined ? { kind: 'static', text: joined[1] } : words[branch.index + 1];
        done.push({ ...branch, split: value ?? { kind: 'static', text: '' }, index: branch.index + (joined ? 1 : 2) });
        continue;
      }
      if (options.none?.test(text)) return { entries: [], items: [] };
      if (options.chdir?.test(text)) { next.push({ ...branch, index: branch.index + 2, changedDirectory: true }); continue; }
      if (options.chdirJoined?.test(text)) { next.push({ ...branch, index: branch.index + 1, changedDirectory: true }); continue; }
      if (name === 'xargs') {
        let replace = null;
        if (text === '-I') replace = textOf(words[branch.index + 1]);
        else if (/^-I./.test(text)) replace = text.slice(2);
        else if (text === '--replace') replace = '{}';
        else if (/^--replace=/.test(text)) replace = text.slice('--replace='.length) || '{}';
        else if (/^-i/.test(text)) replace = text.slice(2) || '{}';
        if (replace !== null) {
          next.push({ ...branch, index: branch.index + (text === '-I' ? 2 : 1), replace });
          continue;
        }
      }
      if (options.next?.test(text)) { next.push({ ...branch, index: branch.index + 2 }); continue; }
      if (options.alone?.test(text)) { next.push({ ...branch, index: branch.index + 1 }); continue; }
      next.push({ ...branch, index: branch.index + 1 }, { ...branch, index: branch.index + 2 });
    }
    // Merge readings that reached the same word with the same facts.
    const seen = new Set();
    branches = next.filter((branch) => {
      const key = `${branch.index}|${branch.changedDirectory}|${branch.replace}|${branch.assignments.length}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (branches.length + done.length > ITEMS_MAX_ALTERNATIVES) return { entries: [], items: [limit('wrappers')] };
  }
  const items = [];
  for (const branch of done) {
    const facts = { wrappers, changedDirectory: branch.changedDirectory, assignments: branch.assignments };
    if (!branch.split && !WRAPPER_POSITIONAL.has(name) && name !== 'xargs' && branch.index < words.length) {
      forks.push({ ...entry, ...facts, offset: branch.index });
      continue;
    }
    let rest = words.slice(branch.index);
    if (branch.split) {
      if (!isStaticWord(branch.split)) { items.push(unseen('variable', null, context)); continue; }
      const nested = parseWords(branch.split.text, depth + 1, context);
      if (nested.limit) { items.push(nested.limit); continue; }
      rest = [...nested.words, ...rest];
    }
    if (WRAPPER_POSITIONAL.has(name) && !branch.empty) {
      // The duration, priority, mask, or lock file comes first.
      if (!rest.length) continue;
      rest = rest.slice(1);
      if (name === 'flock' && /^(?:-c|--command)$/.test(textOf(rest[0]) ?? '')) {
        const program = rest[1];
        if (!program) continue;
        if (!isStaticWord(program)) { items.push(unseen('variable', null, context)); continue; }
        items.push(...parseText(program.text, depth + 1, context));
        continue;
      }
    }
    if (name === 'xargs') {
      // xargs runs `echo` without a command, and appends input words or substitutes them.
      if (!rest.length) rest = [{ kind: 'static', text: 'echo' }];
      const placeholder = { kind: 'pattern', text: '<xargs>', parts: [{ any: 'expansion' }], splits: true, placeholder: 'xargs' };
      rest = branch.replace !== null
        ? rest.map((word, position) => (position > 0 && word.text.includes(branch.replace) ? { ...placeholder, text: word.text } : word))
        : [...rest, placeholder];
    }
    if (!rest.length) {
      // A wrapper without a command is the wrapper itself (`env | sort`, `sudo --`); `exec` with only
      // redirections runs nothing.
      if (name === 'exec') continue;
      items.push(command({ ...entry, exe, words: words.slice(offset), assignments: branch.assignments }, depth, pipe));
      continue;
    }
    forks.push({ ...entry, ...facts, words: rest });
  }
  return { entries: forks, items };
}

// Static text split into words by the shell (for `env -S`): { words } or { limit }.
function parseWords(text, depth, context) {
  if (depth > ITEMS_MAX_DEPTH) return { limit: limit('depth') };
  const lexed = lex(text);
  if (lexed.error) return { limit: limit('syntax') };
  if (lexed.tokens.some((token) => token.type !== 'word')) return { limit: limit('syntax') };
  return { words: lexed.tokens.flatMap((token) => wordsOf(token)) };
}

function unseen(source, producer, context, allowlisted = false) {
  return { kind: 'unseen', source, producer, allowlisted, text: context.text };
}

// Whether a producer's output is reviewed shell setup: one static command.
function setupProducer(producer) {
  if (!producer || producer.kind !== 'command' || !producer.exe || !isStaticWord(producer.exe) || !producer.words.every(isStaticWord)) return false;
  if (producer.stdinFrom === 'pipe') return false;
  const key = producer.key;
  const operands = producer.words.filter((word) => !word.text.startsWith('-')).map((word) => word.text);
  if (key === 'ssh-agent') return true;
  if (SETUP_TOOLS.has(key) && SETUP_VERBS.has(operands[0])) return true;
  if (operands.slice(0, 2).some((word) => word === 'completion' || word === 'completions')) return true;
  // `cat FILE` of one static file: the script-file boundary, like `bash FILE`.
  return key === 'cat' && producer.words.length === 1 && !producer.words[0].text.startsWith('-') && !producer.redirections.length;
}

// The program a command substitution or process substitution word produces: its single command.
function producerOf(word, depth, context) {
  const match = /^[$<>]\(([\s\S]*)\)$|^`([\s\S]*)`$/.exec(word.text.replace(/^"|"$/g, ''));
  if (!match) return null;
  const items = parseText(match[1] ?? match[2], depth + 1, { ...context, functions: new Map(), loops: new Map() });
  const commands = items.filter((item) => item.kind === 'command');
  return items.length === 1 && commands.length === 1 ? commands[0] : null;
}
const sourceOf = (producer) => (producer?.key && NETWORK_PRODUCERS.has(producer.key) ? 'network' : 'output');

// Static bytes a producer feeds to a shell (G10), or null.
function staticFeed(producer) {
  if (!producer?.exe || !isStaticWord(producer.exe) || !producer.words.every(isStaticWord)) return null;
  const words = producer.words.map((word) => word.text);
  if (producer.key === 'echo') {
    let start = 0;
    while (/^-[neE]+$/.test(words[start] ?? '')) start += 1;
    return words.slice(start).join(' ').replace(/\\n/g, '\n');
  }
  if (producer.key === 'printf') {
    const [format = '', ...args] = words;
    const conversions = format.replace(/%%/g, '').match(/%/g)?.length ?? 0;
    if (conversions > 1 || (conversions === 1 && !/%s/.test(format.replace(/%%/g, '')))) return null;
    const unescape = (text) => text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/%%/g, '%');
    if (!conversions) return unescape(format);
    return (args.length ? args : ['']).map((arg) => unescape(format).replace('%s', arg)).join('');
  }
  if (producer.key === 'cat' && !words.length && ['heredoc', 'herestring'].includes(producer.stdinFrom)) {
    const input = [...producer.redirections].reverse().find((redirection) => /^0?$/.test(redirection.fd) && /^(?:<<|<<-|<<<)$/.test(redirection.operator));
    if (!input || (input.heredoc ? !input.heredoc.static : !isStaticWord(input.target))) return null;
    return input.heredoc ? input.heredoc.body : `${input.target.text}\n`;
  }
  return null;
}

// Interpreters and the option that carries an inline program: the program is
// attached (group 1) or the next word. Options are read both ways; the scan stops at `--`, at `stops`
// (python `-m`), and at a static operand no preceding option can take (the script owns later words).
const INTERPRETERS = [
  { keys: ['python', 'py'], language: 'python', option: /^-[bBdEhiIOPqsSuvVxR]*c(.*)$/s, stops: /^-[bBdEhiIOPqsSuvVxR]*m/ },
  { keys: ['node', 'nodejs', 'bun'], language: 'js', option: /^(?:-(?:pe|ep|e|p)|--eval=?|--print=?)(.*)$/s },
  { keys: ['deno'], language: 'js', option: /^(?:eval|--eval=?)(.*)$/s, subcommand: true },
  { keys: ['ruby'], language: 'ruby', option: /^-[acdlnpsSvwyU]*e(.*)$/s },
  { keys: ['perl'], language: 'perl', option: /^-(?:[acfnpsStTuUvwWX]|l[0-7]*|0[0-7]*|0x[0-9A-Fa-f]*)*[eE](.*)$/s },
  { keys: ['php'], language: 'php', option: /^(?:-r|--run=?)(.*)$/s }
];
// The literal characters a word starts with, before its first expansion or glob.
function literalPrefix(word) {
  let text = '';
  for (const part of word.parts ?? []) { if (part.lit === undefined) break; text += part.lit; }
  return text;
}

// The inline programs of a command: { language, programs: [{ text } | { word }] } or null. A program
// that is not static is given as its word.
export function interpreterPrograms(item) {
  if (item?.kind !== 'command' || !item.exe || !isStaticWord(item.exe)) return null;
  const interpreter = INTERPRETERS.find((entry) => entry.keys.includes(item.key));
  if (!interpreter) return null;
  const programs = [];
  const words = item.words;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const previous = words[index - 1];
    const takesValue = previous && (!isStaticWord(previous) || (previous.text.startsWith('-') && !previous.text.includes('=')));
    if (isStaticWord(word) && (word.text === '--' || interpreter.stops?.test(word.text))) break;
    if (!isStaticWord(word)) {
      // An attached or `=` program option with text known only at run time (`python3 -c"$CODE"`,
      // `node --eval=$JS`) gives the same unseen program as the spaced form.
      const prefix = literalPrefix(word);
      const optionLike = prefix.startsWith('-') || (interpreter.subcommand && index === 0);
      if (optionLike && interpreter.option.test(prefix)) programs.push({ word });
      continue;
    }
    const match = interpreter.option.exec(word.text);
    const optionLike = word.text.startsWith('-') || (interpreter.subcommand && index === 0);
    if (match && optionLike) {
      if (match[1] !== '') programs.push({ text: match[1] });
      else if (words[index + 1]) programs.push(isStaticWord(words[index + 1]) ? { text: words[index + 1].text } : { word: words[index + 1] });
      continue;
    }
    if (!word.text.startsWith('-') && !takesValue) break;
  }
  return programs.length ? { language: interpreter.language, programs } : null;
}

// The commands of a nested program run under the wrappers of the command that runs it (`sudo sh -c
// 'rm …'` gives rm administrator authority). The command itself, when returned, already has them.
const inherit = (items, entry) => (entry.wrappers.length ? items.map((item) => (item.kind !== 'command' || item.wrappers === entry.wrappers ? item
  : { ...item, wrappers: [...entry.wrappers, ...item.wrappers] })) : items);

// Commands whose words hold a program: shells, eval, source, pwsh, find actions, function calls.
function programItems(key, exe, words, entry, depth, context, pipe) {
  const self = () => command({ ...entry, exe, words }, depth, pipe);
  if (context.functions.has(exe.text) && entry.wrappers.every((wrapper) => FUNCTION_WRAPPERS.has(wrapper))) return callItems(exe.text, context, new Set()) ?? [limit('size')];
  if (key === 'eval') {
    if (!words.length) return [];
    if (words.every(isStaticWord)) return inherit(programText(words.map((word) => word.text).join(' '), depth, context), entry);
    if (words.length === 1 && words[0].kind === 'pattern' && /^"?(?:\$\([\s\S]*\)|`[\s\S]*`)"?$/.test(words[0].text)) {
      const producer = producerOf(words[0], depth, context);
      const source = sourceOf(producer);
      return [unseen(source, producer, context, source === 'output' && setupProducer(producer))];
    }
    return [unseen('variable', null, context)];
  }
  if (key === 'source' || exe.text === '.') {
    const file = words[0];
    if (file?.procsub) {
      const producer = producerOf(file, depth, context);
      const source = sourceOf(producer);
      return [unseen(source, producer, context, source === 'output' && setupProducer(producer))];
    }
    return [self()];
  }
  if (/^(?:pwsh|powershell)$/.test(key)) return inherit(powershellItems(key, exe, words, entry, depth, context, pipe), entry);
  if (SHELLS.has(key)) return inherit(shellItems(exe, words, entry, depth, context, pipe), entry);
  if (key === 'find') return [self(), ...findActions(words, entry, depth, context)];
  const item = self();
  // An interpreter program known only at run time is unseen (1.8 step 5).
  const inline = interpreterPrograms(item);
  if (inline?.programs.some((program) => program.word)) return [item, unseen('variable', null, context)];
  // An interpreter that reads its program from the network (standard input or `<(…)`) is the same as
  // a shell doing so.
  const fetched = !inline && fetchedProgram(item, entry, depth, context, pipe);
  return fetched ? [fetched, item] : [item];
}

// Interpreters that run a program read from standard input when given no script or `-`, and the
// options of each that take the next word as their value (the script is the first other operand).
// deno reads one only with `run -`.
const STDIN_INTERPRETERS = [
  { keys: ['python', 'py'], values: /^-[WX]$/, module: /^-[bBdEhiIOPqsSuvVxR]*m/ },
  { keys: ['node', 'nodejs'], values: /^(?:-[rC]|--(?:require|import|loader|experimental-loader|conditions|input-type|env-file|inspect-port|title|stack-size))$/ },
  { keys: ['perl'], values: /^-[I]$/ },
  { keys: ['ruby'], values: /^-[ICErFx]$/ },
  { keys: ['php'], values: /^-[cdzt]$/, script: /^-f$/ },
  { keys: ['deno'], values: /^(?:--(?:config|import-map|lock|cert|location|seed|v8-flags|env-file))$/, subcommand: 'run' }
];
// The unseen network program an interpreter command runs, or null: a `<(network producer)` script, or,
// with no script, a network producer on standard input (a pipe or `< <(…)`).
function fetchedProgram(item, entry, depth, context, pipe) {
  const interpreter = STDIN_INTERPRETERS.find((candidate) => candidate.keys.includes(item.key));
  if (!interpreter) return null;
  let words = item.words;
  if (interpreter.subcommand) {
    if (textOf(words[0]) !== interpreter.subcommand) return null;
    words = words.slice(1);
  }
  let script = null;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const text = textOf(word);
    if (text === '--') { script = words[index + 1] ?? null; break; }
    if (text !== null && text !== '-' && text.startsWith('-')) {
      if (interpreter.module?.test(text)) return null;
      if (interpreter.script?.test(text)) { script = words[index + 1] ?? null; break; }
      if (interpreter.values.test(text)) index += 1;
      continue;
    }
    script = word;
    break;
  }
  const network = (producer) => (sourceOf(producer) === 'network' ? unseen('network', producer, context) : null);
  if (script && script.procsub) return network(producerOf(script, depth, context));
  if (script && textOf(script) !== '-') return null;
  if (interpreter.subcommand && !script) return null;
  const input = [...entry.redirections].reverse().find((redirection) => /^0?$/.test(redirection.fd) && !redirection.variable && /^(?:<|<<|<<-|<<<|<>|<&)$/.test(redirection.operator));
  if (input) return input.operator === '<' && input.target?.procsub ? network(producerOf(input.target, depth, context)) : null;
  return pipe.producer !== undefined ? network(pipe.producer) : null;
}

// A program string of `sh -c` or `eval`. One made only of expansions (`bash -c '$SCRIPT'`) is variable
// text like `bash -c "$SCRIPT"`: its words, and so its command, exist only at run time.
function programText(text, depth, context) {
  const items = parseText(text, depth + 1, context);
  const only = items.length === 1 && items[0].kind === 'command' ? items[0] : null;
  if (only && [only.exe, ...only.words].every((word) => word && !isStaticWord(word) && word.kind !== 'opaque' && word.parts.every((part) => part.any === 'expansion'))) return [unseen('variable', null, context)];
  return items;
}

// The body items of a function call, with the calls inside it followed once per name.
// Null past ITEMS_MAX_CALL_ITEMS.
function callItems(name, context, seen) {
  seen.add(name);
  const items = [];
  const body = context.functions.get(name);
  context.budget.calls -= body.length;
  if (context.budget.calls < 0) return null;
  for (const item of body) {
    const callee = item.kind === 'command' && item.exe && isStaticWord(item.exe) ? item.exe.text : null;
    if (callee && context.functions.has(callee) && !seen.has(callee) && item.wrappers.every((wrapper) => FUNCTION_WRAPPERS.has(wrapper))) {
      const called = callItems(callee, context, seen);
      if (!called) return null;
      items.push(...called);
    }
    else items.push({ ...item });
  }
  return items;
}

// `sh`/`bash`/… : `-c STRING`, a static feed on standard input, a script file, or an unseen program.
function shellItems(exe, words, entry, depth, context, pipe) {
  let program = null;
  let readsInput = false;
  let cursor = 0;
  for (; cursor < words.length; cursor += 1) {
    const word = words[cursor];
    if (word.procsub) break;
    if (!isStaticWord(word)) return [unseen('variable', null, context)];
    const text = word.text;
    if (text === '-' || text === '--') { if (text === '-') readsInput = true; cursor += 1; break; }
    if (/^(?:[-+][oO]|--(?:rcfile|init-file))$/.test(text)) { cursor += 1; continue; }
    if (text === '--command' || /^-[^-]*c/.test(text)) { program = 'command'; continue; }
    if (/^-[^-]*s/.test(text)) readsInput = true;
    if (!/^[-+]./.test(text)) break;
  }
  if (program === 'command') {
    const text = words[cursor];
    if (!text) return [];
    if (!isStaticWord(text)) return [unseen('variable', null, context)];
    return programText(text.text, depth, context);
  }
  const operand = words[cursor];
  if (operand && !readsInput) {
    if (!isStaticWord(operand)) {
      if (operand.procsub) {
        const producer = producerOf(operand, depth, context);
        const source = sourceOf(producer);
        return [unseen(source, producer, context, source === 'output' && setupProducer(producer))];
      }
      return [unseen('variable', null, context)];
    }
    return [command({ ...entry, exe, words }, depth, pipe)];
  }
  // Standard input: the last input redirection wins, then the pipe.
  const input = [...entry.redirections].reverse().find((redirection) => /^0?$/.test(redirection.fd) && !redirection.variable && /^(?:<|<<|<<-|<<<|<>|<&)$/.test(redirection.operator));
  if (input) {
    if (input.heredoc || input.operator === '<<<') {
      if (input.heredoc ? !input.heredoc.static : !isStaticWord(input.target)) return [unseen('variable', null, context)];
      return parseText(input.heredoc ? input.heredoc.body : input.target.text, depth + 1, context);
    }
    const file = (input.operator === '<' || input.operator === '<>') && isStaticWord(input.target);
    return [unseen('output', null, context, file)];
  }
  if (pipe.producer !== undefined) {
    const feed = staticFeed(pipe.producer);
    if (feed !== null) return parseText(feed, depth + 1, context);
    const source = sourceOf(pipe.producer);
    return [unseen(source, pipe.producer, context, source === 'output' && setupProducer(pipe.producer))];
  }
  // No script, no -c, and a standard input that is not a static feed (inherited, or given on another
  // descriptor as in `{fd}<<< …`): the shell runs a program no hook can see. Asking for its version or
  // help runs nothing.
  if (words.some((word) => /^--(?:version|help)$/.test(textOf(word) ?? ''))) return [command({ ...entry, exe, words }, depth, pipe)];
  return [unseen('variable', null, context)];
}

// `pwsh`/`powershell`: -Command (or, for Windows PowerShell, the first word) runs the rest of the line;
// -File, or a first word for pwsh, runs a script. -EncodedCommand and unknown options are unseen.
function powershellItems(key, exe, words, entry, depth, context, pipe) {
  for (let cursor = 0; cursor < words.length; cursor += 1) {
    const word = words[cursor];
    if (!isStaticWord(word)) return [unseen('variable', null, context)];
    const value = word.text.toLowerCase();
    if (POWERSHELL_VALUE_OPTIONS.test(value)) { cursor += 1; continue; }
    if (POWERSHELL_FLAGS.test(value)) continue;
    if (/^-f(?:i(?:le?)?)?$/.test(value) || (key === 'pwsh' && !value.startsWith('-'))) return [command({ ...entry, exe, words }, depth, pipe)];
    let payload = cursor;
    if (/^-c(?:o(?:m(?:m(?:a(?:nd?)?)?)?)?)?$/.test(value)) payload = cursor + 1;
    else if (value.startsWith('-')) return [unseen('variable', null, context)];
    const rest = words.slice(payload);
    if (!rest.length) return [];
    if (!rest.every(isStaticWord)) return [unseen('variable', null, context)];
    return parseText(rest.map((item) => item.text).join(' '), depth + 1, context);
  }
  return [command({ ...entry, exe, words }, depth, pipe)];
}

// `find ROOTS … -exec CMD {} ;|+`: the actions run with `{}` standing for a root or a path below it.
function findActions(words, entry, depth, context) {
  let cursor = 0;
  while (/^-(?:[HLP]|O\d*|D)$/.test(textOf(words[cursor]) ?? '')) cursor += textOf(words[cursor]) === '-D' ? 2 : 1;
  const roots = [];
  for (; cursor < words.length; cursor += 1) {
    const text = textOf(words[cursor]);
    if (text !== null && (text.startsWith('-') || text === '(' || text === '!')) break;
    roots.push(words[cursor]);
  }
  const root = roots.length === 1 && isStaticWord(roots[0]) ? roots[0].text : null;
  const placeholderParts = root === null ? [{ any: 'expansion' }] : [...[...root].map((lit) => ({ lit })), { any: 'expansion' }];
  const items = [];
  for (let index = 0; index < words.length; index += 1) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(textOf(words[index]) ?? '')) continue;
    let end = index + 1;
    while (end < words.length && !/^[;+]$/.test(textOf(words[end]) ?? '')) end += 1;
    // Without a terminator find refuses to run, so nothing is executed.
    if (end >= words.length) break;
    const action = words.slice(index + 1, end).map((word) => {
      if (!word.text?.includes('{}')) return word;
      const [before, after] = [word.text.slice(0, word.text.indexOf('{}')), word.text.slice(word.text.indexOf('{}') + 2)];
      return { kind: 'pattern', text: word.text, parts: [...[...before].map((lit) => ({ lit })), ...placeholderParts, ...[...after].map((lit) => ({ lit }))], placeholder: 'find' };
    });
    if (action.length) items.push(...unwrap({ ...entry, words: action, wrappers: [...entry.wrappers, 'find'] }, depth, context, { producer: undefined }));
    index = end;
  }
  return items;
}

// The items of a Bash command, in the order they run. `functions` maps each function
// defined in the call to its body items; `changedDirectory` is true after cd, pushd, or popd.
// Files a network producer writes: its standard output redirected to a file, the file its output
// option names (`curl -o F`, `wget -O F`, `--output F`), the file `curl -O` or `wget` names after the
// URL, or the files `tee` writes from a network producer's pipe. By base name, since a directory change
// may come between.
const baseName = (text) => text.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? '';
const CURL_VALUE_SHORT = new Set([...'AbcCdDeEFHKmPQrtTuUwxXYyz']);
const WGET_VALUE_SHORT = new Set([...'aADeiIlOopPQtTUwX']);
function networkFiles(item) {
  const files = [];
  const add = (word) => { const text = textOf(word); if (text && text !== '-') files.push(baseName(text)); };
  if (item.key === 'tee' && item.producer && NETWORK_PRODUCERS.has(item.producer.key)) {
    for (const word of item.words) if (!(textOf(word) ?? '-').startsWith('-')) add(word);
    return files;
  }
  if (!NETWORK_PRODUCERS.has(item.key)) return files;
  for (const redirection of item.redirections ?? []) {
    if (/^1?$/.test(redirection.fd ?? '') && /^(?:>|>>|>\||&>|&>>)$/.test(redirection.operator)) add(redirection.target);
  }
  const words = item.words;
  const urls = words.filter((word) => /^[a-z][a-z0-9+.-]*:\/\//i.test(textOf(word) ?? ''));
  const named = (url) => { const path = textOf(url).replace(/[?#].*$/, '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); if (baseName(path)) files.push(baseName(path)); };
  let remoteName = item.key === 'wget';
  for (let index = 0; index < words.length; index += 1) {
    const text = textOf(words[index]);
    if (text === null) continue;
    const long = /^--(output|output-document|output-file|remote-name|remote-name-all)(?:=(.*))?$/.exec(text);
    if (long) {
      if (long[1].startsWith('remote-name')) { remoteName = true; continue; }
      if (long[2] !== undefined) files.push(baseName(long[2])); else add(words[++index]);
      if (item.key === 'wget') remoteName = false;
      continue;
    }
    if (!/^-[^-]/.test(text)) continue;
    const valued = item.key === 'wget' ? WGET_VALUE_SHORT : CURL_VALUE_SHORT;
    for (let position = 1; position < text.length; position += 1) {
      const letter = text[position];
      const output = item.key === 'wget' ? letter === 'O' : letter === 'o';
      if (item.key === 'curl' && letter === 'O') { remoteName = true; continue; }
      if (!output && !valued.has(letter) && !(item.key !== 'curl' && item.key !== 'wget' && letter === 'o')) continue;
      const rest = text.slice(position + 1);
      if (output || (item.key !== 'curl' && item.key !== 'wget')) {
        if (rest) { if (rest !== '-') files.push(baseName(rest)); } else add(words[index + 1]);
        if (item.key === 'wget') remoteName = false;
      }
      if (!rest) index += 1;
      break;
    }
  }
  if (remoteName) for (const url of urls) named(url);
  return files;
}
// The file a command runs as a program: a path executable (`./i.sh`), a shell's script, `source` or
// `.`, or an interpreter's script.
const SCRIPT_RUNNERS = new Set([...SHELLS, 'source', 'python', 'py', 'node', 'nodejs', 'bun', 'deno', 'ruby', 'perl', 'php']);
function runFile(item) {
  if (item.kind !== 'command' || !item.exe || !isStaticWord(item.exe)) return null;
  const exe = item.exe.text;
  if (/[\\/]/.test(exe)) return baseName(exe);
  if (!SCRIPT_RUNNERS.has(item.key) && exe !== '.') return null;
  const words = item.key === 'deno' && textOf(item.words[0]) === 'run' ? item.words.slice(1) : item.words;
  const script = words.find((word) => !(textOf(word) ?? '').startsWith('-'));
  return script && isStaticWord(script) ? baseName(script.text) : null;
}
// A file a network producer wrote earlier in the call and a later command runs is a program from the
// network, as if piped into a shell: an unseen network item comes before that command.
function downloadedRuns(items, context) {
  const written = new Map();
  const result = [];
  for (const item of items) {
    if (item.kind === 'command') {
      const file = runFile(item);
      if (file && written.has(file)) result.push(unseen('network', written.get(file), context));
      for (const name of networkFiles(item)) written.set(name, item.key === 'tee' ? item.producer : item);
    }
    result.push(item);
  }
  return result;
}

export function parseShell(command) {
  if (typeof command !== 'string') return Object.assign([limit('syntax')], { functions: new Map() });
  const context = { functions: new Map(), loops: new Map(), text: command, budget: { calls: ITEMS_MAX_CALL_ITEMS }, journal: [] };
  const items = downloadedRuns(parseText(command, 0, context), context);
  let changed = false;
  items.forEach((item, index) => {
    item.index = index;
    if (item.kind !== 'command') return;
    item.changedDirectory ||= changed;
    if (item.key && DIRECTORY_CHANGERS.has(item.key)) changed = true;
    delete item.level;
  });
  return Object.assign(items, { functions: context.functions });
}
// </youdede:shared>

// <youdede:shared capability>
// Capability matcher for Youdede Bash hooks (shared block `capability`, which needs the `shell-items`
// block). A hook declares the commands it protects as data (`CAPABILITY`: families of executables,
// paths, options, safe modes, checks), and this module answers, per hook, a concrete rule id, U
// (uninspectable), or NOT_MINE. Edit it here and run `npm run shared-hooks`;
// tests/shared-hook-capability.test.mjs holds its rules. Every loop is linear in the words, or bounded by
// the path length and the number of safe modes.

export const NOT_MINE = null;
export const U = 'U';

// Precedence: a concrete rule beats U, which beats NOT_MINE.
const rank = (verdict) => (verdict === NOT_MINE ? 0 : verdict === U ? 1 : 2);
export function strongest(...verdicts) {
  let best = NOT_MINE;
  for (const verdict of verdicts) if (rank(verdict) > rank(best)) best = verdict;
  return best;
}

export const isStatic = (word) => word?.kind === 'static';
export const staticText = (word) => (isStatic(word) ? word.text : null);
// A literal character: a static or opaque word, or a pattern with a literal or bracket part.
export const hasLiteral = (word) => Boolean(word) && (word.kind !== 'pattern' || word.parts.some((part) => part.lit !== undefined || part.set));

// M6. canMatch(word, literal, mode): can the word spell `literal` (`exact`), a string that starts with
// it (`prefix`), or one that ends with it (`suffix`)? Case-insensitive. A glob part (`*`, `?`, `[…]`)
// never produces `/`; an expansion part produces anything; an opaque word matches everything.
// Linear in parts x characters.
function partAccepts(part, character) {
  if (part.lit !== undefined) return part.lit.toLowerCase() === character;
  if (character === '/') return false;
  if (part.one) return true;
  const codes = [character.codePointAt(0), character.toUpperCase().codePointAt(0)];
  const inside = codes.some((code) => part.set.some(([low, high]) => code >= low && code <= high));
  return part.negated ? !inside : inside;
}
export function canMatch(word, literal, mode = 'exact') {
  if (!word) return false;
  const target = String(literal).toLowerCase();
  if (word.kind === 'opaque') return true;
  if (word.kind === 'static') {
    const text = word.text.toLowerCase();
    return mode === 'prefix' ? text.startsWith(target) : mode === 'suffix' ? text.endsWith(target) : text === target;
  }
  // A run of wildcard parts matches what its widest part matches; merging keeps the walk linear.
  let parts = [];
  for (const part of word.parts) {
    if (part.any && parts.at(-1)?.any) { if (part.any === 'expansion') parts[parts.length - 1] = part; } else parts.push(part);
  }
  let characters = [...target];
  if (mode === 'suffix') { parts = [...parts].reverse(); characters = characters.reverse(); }
  // States are part indexes; a wildcard part (`any`) may match nothing or repeat.
  const close = (states) => {
    for (const state of [...states]) for (let next = state; next < parts.length && parts[next].any; next += 1) states.add(next + 1);
    return states;
  };
  let states = close(new Set([0]));
  for (const character of characters) {
    const next = new Set();
    for (const state of states) {
      const part = parts[state];
      if (!part) continue;
      if (part.any) { if (part.any === 'expansion' || character !== '/') next.add(state); }
      else if (partAccepts(part, character)) next.add(state + 1);
    }
    states = close(next);
    if (!states.size) return false;
  }
  return mode === 'exact' ? states.has(parts.length) : states.size > 0;
}

// A declared spelling: 'word' (exact), 'pre*' (prefix), '*suf' (suffix), '*' (any word), or a RegExp
// tested on static words only.
function spelling(entry) {
  if (entry instanceof RegExp) return { regex: entry };
  if (entry === '*') return { any: true };
  if (entry.length > 1 && entry.endsWith('*')) return { text: entry.slice(0, -1), mode: 'prefix' };
  if (entry.length > 1 && entry.startsWith('*')) return { text: entry.slice(1), mode: 'suffix' };
  return { text: entry, mode: 'exact' };
}
// 'yes' when a static word has the spelling, 'maybe' when another word can have it, 'no' otherwise.
export function wordMatches(word, entry) {
  const form = spelling(entry);
  if (form.any) return 'yes';
  if (form.regex) return isStatic(word) && form.regex.test(word.text) ? 'yes' : 'no';
  if (!canMatch(word, form.text, form.mode)) return 'no';
  return isStatic(word) ? 'yes' : 'maybe';
}
function stepMatches(word, step) {
  let best = 'no';
  for (const entry of [].concat(step)) {
    const result = wordMatches(word, entry);
    if (result === 'yes') return 'yes';
    if (result === 'maybe') best = 'maybe';
  }
  return best;
}

// npm runs a command from any unique abbreviation of a command or alias, and from its camelCase form
// (`npm pu` publishes). Source: npm 11.19.0, lib/utils/cmd-list.js (`commands`, `aliases`, `deref`) and
// abbrev 4.0.0, checked with `npm pu --help`; tests/shared-hook-capability.test.mjs compares npmCommand
// with the installed npm's deref. pnpm does not abbreviate (`pnpm pu` fails), and Yarn 1.22 runs `yarn pu`
// as the script or binary `pu`, so only npm gets these spellings.
export const NPM_COMMANDS = ['access', 'adduser', 'approve-scripts', 'audit', 'bugs', 'cache', 'ci', 'completion', 'config', 'dedupe',
  'deny-scripts', 'deprecate', 'diff', 'dist-tag', 'docs', 'doctor', 'edit', 'exec', 'explain', 'explore', 'find-dupes', 'fund', 'get',
  'help', 'help-search', 'init', 'install', 'install-ci-test', 'install-scripts', 'install-test', 'link', 'll', 'login', 'logout', 'ls',
  'org', 'outdated', 'owner', 'pack', 'ping', 'pkg', 'prefix', 'profile', 'prune', 'publish', 'query', 'rebuild', 'repo', 'restart',
  'root', 'run', 'sbom', 'search', 'set', 'shrinkwrap', 'stage', 'star', 'stars', 'start', 'stop', 'team', 'test', 'token', 'trust',
  'undeprecate', 'uninstall', 'unpublish', 'unstar', 'update', 'version', 'view', 'whoami'];
export const NPM_ALIASES = {
  author: 'owner', home: 'docs', issues: 'bugs', info: 'view', show: 'view', find: 'search', add: 'install', unlink: 'uninstall',
  remove: 'uninstall', rm: 'uninstall', r: 'uninstall', un: 'uninstall', rb: 'rebuild', list: 'ls', ln: 'link', create: 'init',
  i: 'install', it: 'install-test', cit: 'install-ci-test', u: 'update', up: 'update', c: 'config', s: 'search', se: 'search',
  tst: 'test', t: 'test', ddp: 'dedupe', v: 'view', 'run-script': 'run', 'clean-install': 'ci', 'clean-install-test': 'install-ci-test',
  x: 'exec', why: 'explain', la: 'll', verison: 'version', ic: 'ci', innit: 'init', in: 'install', ins: 'install', inst: 'install',
  insta: 'install', instal: 'install', isnt: 'install', isnta: 'install', isntal: 'install', isntall: 'install', 'install-clean': 'ci',
  'isntall-clean': 'ci', hlep: 'help', 'dist-tags': 'dist-tag', upgrade: 'update', udpate: 'update', rum: 'run', sit: 'install-ci-test',
  urn: 'run', ogr: 'org', 'add-user': 'adduser'
};
// abbrev 4.0.0: every prefix of a word that no neighbouring word (in sorted order) shares.
function abbreviations(words) {
  const list = [...words].sort((a, b) => (a === b ? 0 : a > b ? 1 : -1));
  const map = new Map();
  let prev = '';
  for (let index = 0; index < list.length; index += 1) {
    const current = list[index];
    const next = list[index + 1] || '';
    if (current === next) continue;
    let [nextMatches, prevMatches, j] = [true, true, 0];
    for (; j < current.length; j += 1) {
      nextMatches = nextMatches && current[j] === next[j];
      prevMatches = prevMatches && current[j] === prev[j];
      if (!nextMatches && !prevMatches) { j += 1; break; }
    }
    prev = current;
    if (j === current.length) { map.set(current, current); continue; }
    for (let a = current.slice(0, j); j <= current.length; j += 1) { map.set(a, current); a += current.charAt(j); }
  }
  return map;
}
let npmAbbreviations = null;
// The npm command a word runs, as npm's deref resolves it, or undefined.
export function npmCommand(text) {
  if (!text) return undefined;
  let word = /[A-Z]/.test(text) ? text.replace(/([A-Z])/g, (letter) => `-${letter.toLowerCase()}`) : text;
  if (NPM_COMMANDS.includes(word)) return word;
  if (Object.hasOwn(NPM_ALIASES, word)) return NPM_ALIASES[word];
  npmAbbreviations ??= abbreviations([...NPM_COMMANDS, ...Object.keys(NPM_ALIASES)]);
  word = npmAbbreviations.get(word);
  while (word !== undefined && Object.hasOwn(NPM_ALIASES, word)) word = NPM_ALIASES[word];
  return word;
}
// Every word npm resolves to the same command as `text`: the prefixes of every command and alias, and
// their camelCase forms, kept when they resolve to it. `text` itself stays (older npm commands).
const npmSpellingCache = new Map();
export function npmSpellings(text) {
  if (npmSpellingCache.has(text)) return npmSpellingCache.get(text);
  const target = npmCommand(text);
  const spellings = new Set([text]);
  if (target !== undefined) {
    for (const word of [...NPM_COMMANDS, ...Object.keys(NPM_ALIASES)]) {
      for (let end = 1; end <= word.length; end += 1) {
        const prefix = word.slice(0, end);
        for (const candidate of [prefix, prefix.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]) {
          if (npmCommand(candidate) === target) spellings.add(candidate);
        }
      }
    }
  }
  const list = [...spellings].sort();
  npmSpellingCache.set(text, list);
  return list;
}
// A path whose first step, an npm command, also takes every spelling npm resolves to it.
const npmPaths = new WeakMap();
function npmPath(path) {
  if (!path.length || path[0] === '*') return path;
  if (!npmPaths.has(path)) {
    const first = [].concat(path[0]).flatMap((entry) => (typeof entry === 'string' && spelling(entry).mode === 'exact' ? npmSpellings(entry) : [entry]));
    npmPaths.set(path, [first, ...path.slice(1)]);
  }
  return npmPaths.get(path);
}

export const isOptionWord = (word) => isStatic(word) && word.text.startsWith('-') && word.text !== '-' && word.text !== '--';
const listed = (list, text) => (list ?? []).some((entry) => {
  if (entry instanceof RegExp) return entry.test(text);
  const form = spelling(entry);
  return form.mode === 'prefix' ? text.startsWith(form.text) : form.mode === 'suffix' ? text.endsWith(form.text) : text === form.text;
});

// M2, M3, M4. Walks the readings of the words for one path. An option with `=` stands alone, one in
// `values` takes the next word, one in `flags` takes nothing, and any other option is read both ways.
// `--` ends options: later words are operands only. An operand fills the next path step (M3); a word
// that may split into several words, at a step with steps left, may fill the rest of the path (M3b).
// Each safe mode is 0 (off), 1 (on), or 2 (on, but a later non-static word might undo it) (M4). A
// non-static word before `--` may also be an option that takes the next word: that reading is
// `dynamic` and never gives a concrete rule. Readings are merged per word index on their state, so the
// walk is linear in the words; each final reading keeps its roles as a linked list.
function walk(words, family, path) {
  const modes = family.safe ?? [];
  const could = (word, mode) => [...mode.on, ...mode.off].some((entry) => canMatch(word, entry)
    || (entry.includes('=') && canMatch(word, `${entry.slice(0, entry.indexOf('='))}=`, 'prefix')));
  const signature = (state) => `${state.step}|${state.maybe ? 1 : 0}${state.evidence ? 1 : 0}${state.ended ? 1 : 0}${state.dynamic ? 1 : 0}|${state.safe.join('')}`;
  const buckets = Array.from({ length: words.length }, () => new Map());
  const finals = [];
  const push = (state) => {
    if (!state) return;
    if (state.index >= words.length) finals.push(state);
    else if (!buckets[state.index].has(signature(state))) buckets[state.index].set(signature(state), state);
  };
  push({ index: 0, step: 0, maybe: false, evidence: false, ended: false, dynamic: false, safe: modes.map(() => 0), roles: null });
  if (!words.length) return finals;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    for (const state of buckets[index].values()) {
      const role = (kind) => ({ kind, index, prev: state.roles });
      const valued = (changes) => ({ ...state, ...changes, index: index + 2, roles: { kind: 'value', index: index + 1, prev: role('option') } });
      if (state.ended) { push(fill(state, word, path, role('after'))); continue; }
      if (isStatic(word) && word.text === '--') { push({ ...state, index: index + 1, ended: true, roles: role('terminator') }); continue; }
      if (isOptionWord(word)) {
        const text = word.text;
        const safe = state.safe.map((value, position) => (modes[position].on.includes(text) ? 1 : modes[position].off.includes(text) ? 0 : value));
        const alone = { ...state, safe, index: index + 1, roles: role('option') };
        const last = index + 1 >= words.length;
        if (text.includes('=') || listed(family.flags, text) || last) push(alone);
        else if (listed(family.values, text)) push(valued({ safe }));
        else { push(alone); push(valued({ safe })); }
        continue;
      }
      if (!isStatic(word)) {
        const safe = state.safe.map((value, position) => (value === 1 && could(word, modes[position]) ? 2 : value));
        push(fill({ ...state, safe }, word, path, role('operand')));
        if (index + 1 < words.length) push(valued({ safe, dynamic: true }));
        continue;
      }
      push(fill(state, word, path, role('operand')));
    }
    buckets[index] = null;
  }
  return finals;
}

// An operand: fills the next path step, or is a later operand; null when the path cannot be taken.
function fill(state, word, path, roles) {
  const next = { ...state, index: state.index + 1, roles };
  if (state.step >= path.length) return next;
  const step = path[state.step];
  if (word.splits && !isStatic(word) && state.step < path.length - 1) return { ...next, maybe: true, step: path.length };
  const result = step === '*' ? 'yes' : stepMatches(word, step);
  if (result === 'no') return null;
  return { ...next, step: state.step + 1, maybe: state.maybe || result === 'maybe', evidence: state.evidence || (step !== '*' && hasLiteral(word)) };
}

// The words with the npm command (the operand that filled the first path step) replaced by the declared
// spelling it resolves to, or the words themselves.
function declaredSpelling(words, roles, path) {
  let first = null;
  for (let cell = roles; cell; cell = cell.prev) if (cell.kind === 'operand' || cell.kind === 'after') first = cell;
  const word = first && words[first.index];
  if (!path.length || !isStatic(word)) return words;
  const target = npmCommand(word.text);
  const entry = [].concat(path[0]).find((candidate) => typeof candidate === 'string' && (candidate === word.text || (target !== undefined && npmCommand(candidate) === target)));
  if (!entry || entry === word.text) return words;
  const copy = [...words];
  copy[first.index] = { ...word, text: entry };
  return copy;
}

// The reading of a final state: options (with the value each takes), operands, and the words after `--`.
function readingOf(words, roles) {
  const cells = [];
  for (let cell = roles; cell; cell = cell.prev) cells.push(cell);
  const reading = { positionals: [], options: [], afterTerminator: [] };
  for (const cell of cells.reverse()) {
    const word = words[cell.index];
    if (cell.kind === 'option') reading.options.push({ word, index: cell.index });
    else if (cell.kind === 'value') reading.options.at(-1).value = word;
    else if (cell.kind === 'operand') reading.positionals.push(word);
    else if (cell.kind === 'after') { reading.positionals.push(word); reading.afterTerminator.push(word); }
  }
  return reading;
}

// The reading where unknown options take no value, for a view that follows no family.
export function plainReading(words, values = []) {
  const reading = { positionals: [], options: [], afterTerminator: [] };
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (isStatic(word) && word.text === '--') {
      for (const rest of words.slice(index + 1)) { reading.positionals.push(rest); reading.afterTerminator.push(rest); }
      break;
    }
    if (!isOptionWord(word)) { reading.positionals.push(word); continue; }
    const option = { word, index };
    if (!word.text.includes('=') && listed(values, word.text) && index + 1 < words.length) option.value = words[++index];
    reading.options.push(option);
  }
  return reading;
}

// M1b evidence: a word with a literal character that matches an `evidence` or `decisive` entry; an
// array entry needs each of its spellings on a different word.
function hasEvidence(words, family) {
  const candidates = words.filter(hasLiteral);
  const find = (entry, used) => candidates.findIndex((word, index) => !used.has(index) && wordMatches(word, entry) !== 'no');
  for (const entry of [...(family.evidence ?? []), ...(family.decisive ?? [])]) {
    const used = new Set();
    if ([].concat(entry).every((part) => { const found = find(part, used); used.add(found); return found >= 0; })) return true;
  }
  return false;
}

// M5: a non-static word in a possible option role (not after `--`, not a value) that can spell a
// decisive option or `option=`, or a non-static value of a decisive option.
function decisiveUnknown(reading, words, family) {
  const decisive = (family.decisive ?? []).filter((entry) => typeof entry === 'string');
  if (!decisive.length) return false;
  const excluded = new Set([...reading.afterTerminator, ...reading.options.map((option) => option.value).filter(Boolean)]);
  const spells = (word) => decisive.some((entry) => canMatch(word, entry) || canMatch(word, `${entry.split('=')[0]}=`, 'prefix'));
  if (words.some((word) => !isStatic(word) && !excluded.has(word) && spells(word))) return true;
  return reading.options.some((option) => option.value && !isStatic(option.value) && decisive.includes(option.word.text));
}

// One family for a command whose executable is the family's. `taken` marks a pattern or opaque
// executable ('literal', or 'evidence' when it has no literal character): it never gives a concrete
// rule, and without a literal it needs evidence. Readings and paths combine by precedence.
function judgeFamily(view, family, cap, taken, npm) {
  const words = view.words;
  let best = NOT_MINE;
  const paths = family.paths?.length ? family.paths : [[]];
  for (const [pathIndex, declared] of paths.entries()) {
    const path = npm ? npmPath(declared) : declared;
    for (const state of walk(words, family, path)) {
      if (state.step !== path.length) continue;
      if (taken === 'evidence' && !state.evidence && !hasEvidence(words, family)) continue;
      if (state.safe.includes(1)) continue;
      let verdict = U;
      if (!state.maybe && !state.safe.includes(2)) {
        // A check reads the npm command as declared (`npm rum dev` as `npm run dev`).
        const checkedWords = npm ? declaredSpelling(words, state.roles, declared) : words;
        const reading = readingOf(checkedWords, state.roles);
        const checked = family.check ? cap.checks[family.check]({ ...view, words: checkedWords, reading, pathIndex, pathLength: path.length }) : family.rule;
        verdict = strongest(checked, decisiveUnknown(reading, words, family) ? U : NOT_MINE);
        if (verdict !== NOT_MINE && (taken || state.dynamic)) verdict = U;
      }
      best = strongest(best, verdict);
      if (rank(best) === 2) return best;
    }
  }
  return best;
}

// The key part of a pattern executable: after its last literal `/`, cut at its first literal `.`,
// without trailing literal digits.
function executableKeyWord(exe) {
  let parts = exe.parts;
  const slash = parts.findLastIndex((part) => part.lit === '/' || part.lit === '\\');
  if (slash >= 0) parts = parts.slice(slash + 1);
  const dot = parts.findIndex((part) => part.lit === '.');
  if (dot > 0) parts = parts.slice(0, dot);
  while (parts.length > 1 && /\d/.test(parts.at(-1).lit ?? '')) parts = parts.slice(0, -1);
  return { ...exe, parts };
}

// Runners: the command a package runner starts, after the runner's options and its
// verb (`npx`, `bunx`, `pnpx`, `pnpm [exec|dlx]`, `yarn [dlx|exec]`, `bun run|x`, `npm exec|x`,
// `bundle exec`, `uv run`, `poetry run`). pnpm and Yarn also run a package binary without a verb. The
// runner's last option may take the next word, so that word and the one after it are both read as
// the command.
const RUNNERS = { npx: null, bunx: null, pnpx: null, pnpm: ['exec', 'dlx'], yarn: ['dlx', 'exec'], bun: ['run', 'x'], npm: ['exec', 'x'], bundle: ['exec'], uv: ['run'], poetry: ['run'] };
const OPTIONAL_VERB = new Set(['pnpm', 'yarn']);
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'bun', 'npm']);
function runnerViews(view) {
  const verbs = RUNNERS[view.key];
  if (verbs === undefined) return [];
  const words = view.words;
  let index = 0;
  const skipOptions = () => { while (index < words.length && (isOptionWord(words[index]) || staticText(words[index]) === '--')) index += 1; };
  skipOptions();
  if (verbs) {
    const verb = staticText(words[index]);
    if (verbs.includes(verb) || (view.key === 'npm' && npmCommand(verb) === 'exec')) { index += 1; skipOptions(); }
    else if (!OPTIONAL_VERB.has(view.key)) return [];
  }
  const starts = [index];
  const previous = words[index - 1];
  if (isOptionWord(previous) && !previous.text.includes('=') && index + 1 < words.length) starts.push(index + 1);
  return starts.filter((start) => start < words.length).map((start) => {
    // A package runner names a package spec, whose binary is the package name without its version
    // (`npx npm@10`, `pnpm dlx @scope/tool@1`).
    const word = words[start];
    const exe = isStatic(word) && PACKAGE_RUNNERS.has(view.key) ? { ...word, text: word.text.replace(/(?<=.)@[^@/]*$/, '') } : word;
    return { ...view, exe, key: isStatic(exe) ? commandKey(exe.text) : null, words: words.slice(start + 1) };
  });
}

// M1. A static executable selects the families that name its key. A pattern or opaque executable is a
// candidate of a family when its key can spell one of the family's executables. A hook with
// `runners: true` also judges the command a runner starts.
export function judgeCommand(view, cap) {
  const best = cap.commands ? strongest(cap.checks[cap.commands](view)) : NOT_MINE;
  if (rank(best) === 2 || !view.exe) return best;
  return strongest(best, judgeFamilies(view, cap, 0));
}
const RUNNER_DEPTH = 4;
function judgeFamilies(view, cap, depth) {
  let best = NOT_MINE;
  const exe = view.exe;
  const key = isStatic(exe) ? commandKey(exe.text) : null;
  const base = exe.kind === 'pattern' ? executableKeyWord(exe) : exe;
  for (const family of cap.families ?? []) {
    const names = family.executables.map(commandKey);
    let taken = false;
    if (key !== null) { if (!names.includes(key)) continue; }
    else if (!names.some((name) => canMatch(base, name))) continue;
    else taken = hasLiteral(base) ? 'literal' : 'evidence';
    // An executable that is (or can spell) npm reads the family's npm commands as npm resolves them.
    const npm = names.includes('npm') && (key === 'npm' || (key === null && canMatch(base, 'npm')));
    best = strongest(best, judgeFamily(view, family, cap, taken, npm));
    if (rank(best) === 2) return best;
  }
  if (!cap.runners || depth >= RUNNER_DEPTH) return best;
  for (const inner of runnerViews(view)) {
    best = strongest(best, judgeFamilies(inner, cap, depth + 1));
    if (rank(best) === 2) return best;
  }
  return best;
}

// A hook's visible phrases, word-bounded and case-insensitive, in an unseen program's text.
export function mentions(cap, text) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return (cap.visible ?? []).some((phrase) => new RegExp(`${/^\w/.test(phrase) ? '(?<![\\w-])' : ''}${escape(phrase)}${/\w$/.test(phrase) ? '(?![\\w-])' : ''}`, 'i').test(text));
}

// Items in order; the first one that is not NOT_MINE decides. A Limit is U. An Unseen program is the
// hook's `unseen` check's, or U when it mentions a visible phrase. A command whose executable is neither
// static nor literal, in a call that defines functions, is U when a function body concerns the hook.
// `options.inline` judges interpreter programs (inline.mjs) for the hooks that use it.
export function judgeItems(items, cap, options = {}) {
  const functions = items.functions ?? new Map();
  let bodies = null;
  for (const item of items) {
    let verdict = NOT_MINE;
    if (item.kind === 'limit') verdict = U;
    else if (item.kind === 'unseen') verdict = cap.unseen ? cap.checks[cap.unseen](item) : mentions(cap, item.text) ? U : NOT_MINE;
    else {
      verdict = judgeCommand(item, cap);
      if (verdict === NOT_MINE && options.inline) verdict = options.inline(item, cap);
      if (verdict === NOT_MINE && item.exe && !isStatic(item.exe) && !hasLiteral(item.exe) && functions.size) {
        bodies ??= [...functions.values()].some((body) => judgeItems(body, cap, options) !== NOT_MINE);
        if (bodies) verdict = U;
      }
    }
    if (verdict !== NOT_MINE) return verdict;
  }
  return NOT_MINE;
}

// The verdict of a hook's capability on a Bash command.
export function judge(command, cap, options = {}) {
  return judgeItems(parseShell(command), cap, options);
}
// </youdede:shared>

// <youdede:shared commit-content>
// What the `git commit` calls of a Bash command will take (shared block `commit-content`, which needs the
// `shell-items` and `capability` blocks): the `CommitIntent` record and the resolved
// Git calls it is built from. Nothing is executed; configured aliases are read once, one level deep.
// Edit it here and run `npm run shared-hooks`.

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
// Git global options that take the next word as their value.
export const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--attr-source', '--list-cmds'];
const COMMIT_VALUE_OPTIONS = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '--author',
  '--date', '--fixup', '--squash', '-t', '--template', '--cleanup', '--trailer'
]);
const COMMIT_WORKTREE_OPTION = /^--(?:all|include|only|interactive|patch|pathspec-from-file(?:=.*)?)$/;
const SHORT_WORKTREE_FLAGS = new Set(['a', 'i', 'o', 'p']);
const SHORT_VALUE_NEXT = new Set(['m', 'F', 'C', 'c', 't']);
const SHORT_VALUE_ATTACHED = new Set(['S', 'u']);
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);
// Relevance of a command to the commit hooks: the commit family through the shared matcher (M1 to M7).
const COMMIT_CAPABILITY = {
  hook: 'commit-content', uninspectable: 'commit-content-uninspectable', visible: ['git commit'],
  families: [{ executables: ['git'], paths: [['commit']], values: GIT_VALUE_OPTIONS, rule: 'commit' }], checks: {}
};

// Walks the options of `git commit` args, which Git parses before and after pathspecs; `visit(flag)`
// sees each long option and each short flag and returns true to stop. A word known only at run time
// counts as a pathspec, even where an option takes it as its value.
function walkCommitOptions(words, visit) {
  let pathspec = false;
  const takesValue = (index) => { if (words[index] && !isStatic(words[index])) pathspec = true; };
  for (let index = 0; index < words.length; index += 1) {
    if (!isStatic(words[index])) { pathspec = true; continue; }
    const value = words[index].text;
    if (value === '--') return { stopped: false, pathspec: pathspec || index + 1 < words.length };
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
export function commitReadsWorkingTree(words) {
  const walked = walkCommitOptions(words, (flag) => COMMIT_WORKTREE_OPTION.test(flag) || (flag.length === 2 && SHORT_WORKTREE_FLAGS.has(flag[1])));
  return walked.stopped || walked.pathspec;
}

// True when the commit skips the repository's hooks: -n in any short-option group, or
// --no-verify and its unambiguous abbreviations.
export function commitSkipsHooks(words) {
  return walkCommitOptions(words, (flag) => flag === '-n' || /^--no-v(?:e(?:r(?:i(?:fy?)?)?)?)?$/.test(flag)).stopped;
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

// `git [global options] <subcommand> [args]` of one command item, or null for another command.
// { dynamic } when a global option, its value, or the subcommand is known only at run time; else
// { name, args, config, scoped }: `config` lists the -c and --config-env settings, `scoped` is true
// when -C, --git-dir, --work-tree, or a GIT_DIR/GIT_WORK_TREE assignment points Git elsewhere.
export function gitCommand(item) {
  if (item.kind !== 'command' || item.key !== 'git') return null;
  const config = [];
  let scoped = (item.assignments ?? []).some((assignment) => /^GIT_(?:DIR|WORK_TREE)$/.test(assignment.name));
  const words = item.words;
  let index = 0;
  while (index < words.length) {
    if (!isStatic(words[index])) return { dynamic: true };
    const value = words[index].text;
    if (value === '--') { index += 1; break; }
    if (!value.startsWith('-')) break;
    let option = value;
    let setting = null;
    if (GIT_VALUE_OPTIONS.includes(value)) {
      if (!words[index + 1] || !isStatic(words[index + 1])) return { dynamic: true };
      setting = words[index + 1].text;
      index += 2;
    } else {
      const equals = value.indexOf('=');
      if (value.startsWith('--') && equals > 0) { option = value.slice(0, equals); setting = value.slice(equals + 1); }
      index += 1;
    }
    if (['-C', '--git-dir', '--work-tree'].includes(option)) scoped = true;
    else if (option === '-c' && setting !== null) {
      const separator = setting.indexOf('=');
      config.push(separator < 0 ? { key: setting.toLowerCase(), value: 'true' } : { key: setting.slice(0, separator).toLowerCase(), value: setting.slice(separator + 1) });
    } else if (option === '--config-env' && setting !== null) {
      const separator = setting.indexOf('=');
      config.push({ key: (separator < 0 ? setting : setting.slice(0, separator)).toLowerCase(), value: null });
    }
  }
  const subcommand = words[index];
  if (!subcommand) return { name: null, args: [], config, scoped };
  if (!isStatic(subcommand)) return { dynamic: true };
  return { name: subcommand.text.toLowerCase(), args: words.slice(index + 1), config, scoped };
}

// `git config [set] [options] alias.<name> <value>`: [name, value], name '*' or value null when known
// only at run time; null for another setting.
function aliasDefinition(args) {
  const positional = [];
  for (let index = isStatic(args[0] ?? { kind: 'opaque' }) && args[0].text === 'set' ? 1 : 0; index < args.length && positional.length < 2; index += 1) {
    const word = args[index];
    if (isStatic(word) && word.text.startsWith('-') && positional.length === 0) {
      if (CONFIG_VALUE_OPTIONS.has(word.text)) index += 1;
      continue;
    }
    positional.push(word);
  }
  const [key, value] = positional;
  if (!key || !value) return null;
  if (!isStatic(key)) return ['*', null];
  if (!/^alias\./i.test(key.text)) return null;
  return [key.text.slice('alias.'.length).toLowerCase(), isStatic(value) ? value.text : null];
}

// The Git calls of a command in order, each alias resolved one level: { calls, uninspectable }. A call
// is { item, name, args, config, scoped, alias }, with `alias` one of null, 'defined' (defined in this
// command or with -c), 'shell' (a `!` alias), 'chain' (an alias of an alias), or 'dynamic' (its value
// is known only at run time); `name` is null when the alias is not followed. `options.aliases` is a
// Map or a function returning one, read at most once and only for a subcommand that is not built in.
export function gitCalls(items, options = {}) {
  const calls = [];
  let uninspectable = false;
  let configured;
  const aliasesOf = () => (configured ??= typeof options.aliases === 'function' ? options.aliases() : options.aliases instanceof Map ? options.aliases : new Map());
  const defined = new Map();
  for (const item of items) {
    const verdict = judgeItems(Object.assign([item], { functions: items.functions }), COMMIT_CAPABILITY);
    if (verdict === U) uninspectable = true;
    const git = gitCommand(item);
    if (!git) continue;
    if (git.dynamic) {
      if (verdict !== NOT_MINE) uninspectable = true;
      calls.push({ item, name: null, args: [], config: [], scoped: false, alias: 'dynamic' });
      continue;
    }
    if (!git.name) continue;
    let call = { item, ...git, alias: null };
    if (!GIT_BUILTINS.has(git.name)) {
      let value;
      for (const setting of git.config) if (setting.key === `alias.${git.name}`) value = setting.value;
      const local = value !== undefined || defined.has(git.name) || defined.has('*');
      if (value === undefined) value = defined.has(git.name) ? defined.get(git.name) : defined.has('*') ? null : aliasesOf().get(git.name);
      // Not an alias: an external `git-<name>` program, which this analysis does not follow.
      if (value === undefined) continue;
      if (value === null) { uninspectable = true; calls.push({ ...call, name: null, alias: 'dynamic' }); continue; }
      if (value.startsWith('!')) { calls.push({ ...call, name: null, alias: 'shell' }); continue; }
      const expansion = parseShell(`git ${value}`);
      const expanded = expansion.length === 1 ? gitCommand(expansion[0]) : null;
      if (!expanded || expanded.dynamic || !expanded.name) { uninspectable = true; calls.push({ ...call, name: null, alias: 'dynamic' }); continue; }
      if (!GIT_BUILTINS.has(expanded.name)) { calls.push({ ...call, name: null, alias: 'chain' }); continue; }
      call = { ...call, name: expanded.name, args: [...expanded.args, ...git.args], config: [...git.config, ...expanded.config], scoped: git.scoped || expanded.scoped, alias: local ? 'defined' : null };
    }
    if (call.config.some((setting) => setting.key.startsWith('alias.'))) call.alias ??= 'defined';
    if (call.name === 'config') {
      const definition = aliasDefinition(call.args);
      if (definition) defined.set(definition[0], definition[1]);
    }
    calls.push(call);
  }
  return { calls, uninspectable };
}

// Commit intent of a command: `found` when a commit may run;
// `unsupported` when it runs in the same command as a forced add, an alias definition, a shell alias,
// or an alias of an alias; `scopeChanged` after cd/pushd or with -C, --git-dir, --work-tree, GIT_DIR, or
// GIT_WORK_TREE; `worktree` when it can take working-tree content (earlier staging, -a, a pathspec);
// `noVerify` when it skips the repository's hooks (-n, --no-verify, -c core.hooksPath=…).
export function commitIntent(items, options = {}) {
  const { calls, uninspectable } = gitCalls(items, options);
  const intent = { found: false, uninspectable, unsupported: null, scopeChanged: false, worktree: false, noVerify: false };
  let staged = false;
  let forced = false;
  let defined = false;
  const unsupported = (kind) => { intent.found = true; intent.unsupported ??= kind; };
  for (const call of calls) {
    if (call.alias === 'defined' || call.config.some((setting) => setting.key.startsWith('alias.'))) defined = true;
    if (call.alias === 'shell') unsupported('shell-alias');
    else if (call.alias === 'chain') unsupported('alias-chain');
    if (!call.name) { if (call.alias === 'dynamic') staged = true; continue; }
    if (call.name === 'config' && aliasDefinition(call.args)) defined = true;
    if (call.name === 'commit') {
      intent.found = true;
      intent.scopeChanged ||= call.item.changedDirectory || call.scoped;
      intent.worktree ||= staged || commitReadsWorkingTree(call.args);
      intent.noVerify ||= commitSkipsHooks(call.args) || call.config.some((setting) => setting.key === 'core.hookspath');
    } else if (COMMIT_STAGING_SUBCOMMANDS.has(call.name)) {
      staged = true;
      if ((call.name === 'add' || call.name === 'stage') && forcesAdd(call.args)) forced = true;
    }
  }
  if (intent.found && forced) intent.unsupported ??= 'force-add';
  if (intent.found && defined) intent.unsupported ??= 'alias-definition';
  return intent;
}

// `git add -f` / `git stage --force` (a word known only at run time is read as a path, as before).
function forcesAdd(args) {
  for (const word of args) {
    if (!isStatic(word)) continue;
    if (word.text === '--') return false;
    if (/^--for(?:ce?)?$/.test(word.text) || (/^-[A-Za-z]+$/.test(word.text) && word.text.includes('f'))) return true;
  }
  return false;
}
// </youdede:shared>

function cleanGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_LOCKFILE_BYTES = 2 * 1024 * 1024;
export const MAX_LOCKFILES = 24;

const LOCKFILE = /(?:^|\/)package-lock\.json$/i;

export const CAPABILITY = {
  hook: 'lockfile-origin-guard', uninspectable: 'lockfile-origin-inspection-incomplete', visible: ['git commit'],
  families: [{ executables: ['git'], paths: [['commit']], values: GIT_VALUE_OPTIONS, rule: 'commit' }], checks: {}
};

// 'irrelevant', 'uninspectable', or { worktree } for the commits in the command.
export function commitScope(command, options = {}) {
  if (typeof command !== 'string' || !command) return 'irrelevant';
  const intent = commitIntent(parseShell(command), options);
  if (intent.uninspectable) return 'uninspectable';
  if (!intent.found) return 'irrelevant';
  if (intent.unsupported || intent.scopeChanged) return 'uninspectable';
  return { worktree: intent.worktree };
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
// and untracked non-ignored files (a forced add in the same command is refused before this runs).
function worktreeLockfiles(root) {
  const top = git(root, ['rev-parse', '--show-toplevel'], 64 * 1024).trim();
  const listed = git(top, ['ls-files', '-z', '--modified', '--others', '--exclude-standard'], 16 * 1024 * 1024);
  const files = [];
  for (const name of new Set(listed.split('\0').filter((entry) => LOCKFILE.test(entry)))) {
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
    intent = commitScope(command, { aliases: () => readGitAliases((args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, env: cleanGitEnvironment() })) });
  } catch { return { relevant: true, invalid: true }; }
  if (intent === 'irrelevant') return { relevant: false };
  if (intent === 'uninspectable') return { relevant: true, invalid: true };
  try {
    const top = git(root, ['rev-parse', '--show-toplevel'], 64 * 1024).trim();
    const names = git(top, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], 256 * 1024)
      .split('\0').filter((name) => LOCKFILE.test(name));
    const worktree = intent.worktree ? worktreeLockfiles(root) : [];
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
