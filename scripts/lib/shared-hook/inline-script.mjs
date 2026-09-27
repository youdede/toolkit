// Shell commands written inside an interpreter one-liner (shared block `inline-script`), such as
// `python3 -c "os.system('npm publish')"` or `cmd /c "sc stop x"`. scripts/generate-shared-hooks.mjs
// drops the import below and requires the `shell` block in the same hook. Edit it here and run
// `npm run shared-hooks`. Nothing is executed. A program that builds its command at run time, or passes
// it as an argument list, is not seen as a command; see `inlineShellCommands` for when it is ambiguous.
import { executableName, parseShellCommands } from './shell.mjs';

// Interpreter -> option that carries the inline program, as a separate word (`-c CODE`) or attached
// (`-cCODE`, `--eval=CODE`): group 1 is the attached program. Then whether the program runs to the end
// of the command line, and its language, which picks the literal and comment forms. cmd programs are
// shell-like, so the whole program is read as a command too. PowerShell is unwrapped by the `shell`
// block itself.
const INLINE_PROGRAM_OPTIONS = [
  [/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/, /^-[bBdEhiIOPqsSuvVxR]*c(.*)$/s, false, 'python'],
  [/^(?:node|nodejs|bun)(?:\.exe)?$/, /^(?:-(?:pe|ep|e|p)=?|--eval=|--eval$|--print=|--print$)(.*)$/s, false, 'js'],
  [/^deno(?:\.exe)?$/, /^(?:eval$|--eval$|--eval=)(.*)$/s, true, 'js'],
  [/^ruby(?:\.exe)?$/, /^-[acdlnpsSvwyU]*e(.*)$/s, false, 'ruby'],
  [/^perl(?:\.exe)?$/, /^-(?:[acfnpsStTuUvwWX]|l[0-7]*|0[0-7]*|0x[0-9A-Fa-f]*)*[eE](.*)$/s, false, 'perl'],
  [/^php(?:\.exe)?$/, /^(?:-[rBRE]|--(?:run|process-begin|process-code|process-end)(?:=|$))(.*)$/s, false, 'php'],
  [/^cmd(?:\.exe)?$/, /^\/[cCkKrR](.*)$/s, true, 'cmd']
];
const INLINE_MAX_LITERALS = 256;
const INLINE_PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };
// A program is `capable` when its code (literal contents and comments removed) names something that
// can run a command: a module, a call, an executing literal (backtick outside JS, `%x`, `qx`, whose
// opener stays in the code), or a dynamic name. With a dynamic name the program can reach any call, so
// it is also ambiguous. Without any of these, the program's literals are data.
const INLINE_DYNAMIC_NAMES = /\b(?:getattr|__import__|importlib|eval|exec|compile|require|send|public_send|__send__|method|instance_eval|constantize)\b|\bimport\s*\(/;
const INLINE_CAPABLE = /\b(?:subprocess|pty|PTY|commands|child_process|execa|Kernel|Open3|system|exec\w*|spawn\w*|posix_spawn\w*|fork|popen\w*|readpipe|syscall|open|shell_exec|passthru|proc_open|pcntl_exec|qx)\b|\b(?:os|posix)\s*\.\s*(?:system|popen|exec\w*|spawn\w*)|\bIO\s*\.\s*popen|\bBun\s*\.\s*(?:spawn\w*|\$)|\$`|\bDeno\s*\.\s*(?:Command|run)\b|`|%x/;
// Interpolation inside a literal is code: Ruby `#{…}`, JS `${…}`, Perl `@{[…]}`, PHP `{$…}`.
const INLINE_INTERPOLATION = /#\{|\$\{|@\{|\{\$/;
// A here-document the reader does not follow: Ruby and Perl `<<ID`, `<<~ID`, `<<-ID`, `<<"ID"`, and PHP `<<<ID`.
const INLINE_HEREDOC = { ruby: /<<[~-]?(?:[A-Za-z_]|["'`])/, perl: /<<~?(?:[A-Za-z_]|\s*["'`])/, php: /<<<\s*["']?[A-Za-z_]/ };

// The opening of a literal at `index`: the text that opens it, its delimiter, and whether running the
// program executes it as a command (backticks outside JS, Ruby `%x`, Perl `qx`). Quotes open a literal
// in every language; Ruby adds `%q`/`%Q`/`%x` with any delimiter and `%(…)`-style bare forms, Perl
// adds `q`/`qq`/`qx` with any delimiter.
function literalOpening(program, index, language) {
  const character = program[index];
  if (character === "'" || character === '"') return { opener: character, delimiter: character, executes: false };
  if (character === '`') return { opener: '`', delimiter: '`', executes: language !== 'js' };
  const rest = program.slice(index, index + 8);
  if (language === 'ruby' && character === '%') {
    const match = /^%([qQx]?)([^\w\s])/.exec(rest);
    if (match && (match[1] || match[2] in INLINE_PAIRS)) return { opener: match[0], delimiter: match[2], executes: match[1] === 'x' };
  }
  if (language === 'perl' && character === 'q' && !/[\w$@%&>]/.test(program[index - 1] ?? '')) {
    const match = /^(qq|qx|q)\s*([^\w\s=,;)])/.exec(rest);
    if (match) return { opener: match[0], delimiter: match[2], executes: match[1] === 'qx' };
  }
  return null;
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
      if (character === '\\') { cursor += 1; body += program[cursor] ?? ''; continue; }
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
      inner = nested.code;
    } else if (interpolated) incomplete = true;
    code += `${opening.executes ? opening.opener : ''} ${inner} `;
    index = cursor + 1;
  }
  return { literals, code, incomplete };
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
  const [, option, toEnd, language] = known;
  const shellLike = language === 'cmd';
  const parts = [];
  let dynamic = false;
  for (let index = 1; index < entry.tokens.length; index += 1) {
    const match = option.exec(entry.tokens[index].value);
    if (!match) continue;
    // A program attached to its option is part of the same word; otherwise it is the next word.
    const attached = match[1] !== '' || /=$/.test(entry.tokens[index].value);
    const first = attached ? index : index + 1;
    const words = toEnd ? entry.tokens.slice(first) : entry.tokens.slice(first, first + 1);
    if (!words.length) continue;
    dynamic ||= words.some((token) => token.dynamic || token.placeholder);
    parts.push([...(attached ? [match[1]] : []), ...words.slice(attached ? 1 : 0).map((token) => token.value)].join(' '));
    if (toEnd) break;
    if (attached) index = first;
  }
  if (!parts.length) return null;
  const text = parts.join('\n');
  const { literals, code, incomplete } = scanProgram(text, language);
  const capable = shellLike || INLINE_CAPABLE.test(code) || INLINE_DYNAMIC_NAMES.test(code);
  // A program the reader did not follow to the end is ambiguous whatever the read part holds: the unread
  // part may run anything. A capable program is ambiguous too when it names something dynamically or
  // holds a here-document.
  const ambiguous = !shellLike && (incomplete || (capable && (INLINE_DYNAMIC_NAMES.test(code) || Boolean(INLINE_HEREDOC[language]?.test(text)))));
  return { text, dynamic, shellLike, literals, capable, ambiguous };
}

// Normalized commands (the shape parseShellCommands returns) found in the inline program of `entry`.
// Without `capable`, the literals are data and nothing is returned. With it, every literal is read as a
// shell command, even one the program only prints (`import subprocess; print('npm publish')` counts):
// the reader does not follow data flow. Candidates that do not parse are skipped. A literal that runs a
// shell without a static command (`sh`), a program not known before the command runs, a program the
// reader did not follow to the end (capable or not), and a capable program with a dynamic name or a
// here-document add an `{ ambiguous: true }` entry, after the literal commands.
export function inlineShellCommands(entry) {
  const program = inlineProgram(entry);
  if (!program) return [];
  if (program.dynamic) return [{ ambiguous: true, tokens: [], wrappers: entry.wrappers ?? [] }];
  if (!program.capable) return program.ambiguous ? [{ ambiguous: true, tokens: [], wrappers: entry.wrappers ?? [] }] : [];
  const sources = [...(program.shellLike ? [program.text] : []), ...program.literals];
  const commands = [];
  for (const source of sources) {
    const parsed = parseShellCommands(source, 1, [...(entry.wrappers ?? []), executableName(entry.tokens[0])]);
    if (!parsed.error) commands.push(...parsed.commands.filter((command) => command.tokens?.length || command.ambiguous));
  }
  if (program.ambiguous) commands.push({ ambiguous: true, tokens: [], wrappers: entry.wrappers ?? [] });
  return commands;
}
