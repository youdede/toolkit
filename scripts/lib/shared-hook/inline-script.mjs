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
    const parsed = parseShellCommands(source, 1, [...(entry.wrappers ?? []), executableName(entry.tokens[0])]);
    if (!parsed.error) commands.push(...parsed.commands.filter((command) => command.tokens?.length || command.ambiguous));
  }
  if (program.ambiguous) commands.push(unfollowed);
  return commands;
}
