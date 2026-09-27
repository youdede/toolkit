// Shell commands written inside an interpreter one-liner (shared block `inline-script`), such as
// `python3 -c "os.system('npm publish')"` or `cmd /c "sc stop x"`. scripts/generate-shared-hooks.mjs
// drops the import below and requires the `shell` block in the same hook. Edit it here and run
// `npm run shared-hooks`. Nothing is executed. A program that builds its command at run time, or passes
// it as an argument list, is not seen.
import { executableName, parseShellCommands } from './shell.mjs';

// Interpreter -> option that carries the inline program, as a separate word (`-c CODE`) or attached
// (`-cCODE`, `--eval=CODE`): group 1 is the attached program. Then the calls that run a command, looked
// for in the program's code only (literal contents and comments removed): only with one of them are the
// program's string literals read as commands, otherwise they are data. Then whether the program runs to
// the end of the command line, and its language, which picks the literal and comment forms. cmd programs
// are shell-like (no call list), so the whole program is read as a command too. PowerShell is unwrapped
// by the `shell` block itself.
// ponytail: the call check is textual; a call name built at run time (getattr(os, 'sys' + 'tem')) is missed.
const INLINE_PROGRAM_OPTIONS = [
  [/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/, /^-[bBdEhiIOPqsSuvVxR]*c(.*)$/s,
    /\b(?:system|popen|subprocess|pty|spawn\w*|posix_spawn\w*|exec[lv]\w*)\b/, false, 'python'],
  [/^(?:node|nodejs|bun)(?:\.exe)?$/, /^(?:-(?:pe|ep|e|p)=?|--eval=|--eval$|--print=|--print$)(.*)$/s,
    /child_process|\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\b|\bBun\s*\.\s*(?:spawn|spawnSync|\$)/, false, 'js'],
  [/^deno(?:\.exe)?$/, /^(?:eval$|--eval$|--eval=)(.*)$/s, /\bDeno\s*\.\s*(?:Command|run)\b/, true, 'js'],
  [/^ruby(?:\.exe)?$/, /^-[acdlnpsSvwyU]*e(.*)$/s,
    /\b(?:system|exec|spawn|popen\w*|Open3|PTY|open|syscall)\b|`|%x/, false, 'ruby'],
  [/^perl(?:\.exe)?$/, /^-(?:[acfnpsStTuUvwWX]|l[0-7]*|0[0-7]*|0x[0-9A-Fa-f]*)*[eE](.*)$/s,
    /\b(?:system|exec|qx|open|readpipe)\b|`/, false, 'perl'],
  [/^php(?:\.exe)?$/, /^(?:-[rBRE]|--(?:run|process-begin|process-code|process-end)(?:=|$))(.*)$/s,
    /\b(?:exec|system|passthru|shell_exec|popen|proc_open|pcntl_exec)\b|`/, false, 'php'],
  [/^cmd(?:\.exe)?$/, /^\/[cCkKrR](.*)$/s, null, true, 'cmd']
];
const INLINE_MAX_LITERALS = 256;
const INLINE_PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };
// A literal whose contents name what the code loads or calls (`require('child_process')`,
// `getattr(os, 'system')`) stays in the code the call check reads.
const INLINE_NAMING_CONTEXT = /(?:\b(?:require|import|__import__|import_module|send|public_send|__send__|method)\s*\(?|\bfrom|\bgetattr\s*\([^()]*,)\s*$/;
// Interpolation inside a literal is code: Ruby `#{…}`, JS `${…}`, Perl `@{[…]}`, PHP `{$…}`.
const INLINE_INTERPOLATION = /#\{|\$\{|@\{|\{\$/;

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

// String literals of a program, without their delimiters (escapes keep the escaped character; paired
// delimiters nest), and the program's code with literal contents and comments removed. An executing
// literal leaves its opener in the code, so the call check still sees it, and an interpolating one is
// scanned again as code, two levels deep. One pass: an unterminated literal ends the scan.
function scanProgram(program, language, depth = 0) {
  const literals = [];
  let code = '';
  let index = 0;
  while (index < program.length && literals.length < INLINE_MAX_LITERALS) {
    const opening = literalOpening(program, index, language);
    if (!opening) {
      const end = commentEnd(program, index, language);
      if (end < 0) code += program[index];
      index = end < 0 ? index + 1 : end;
      continue;
    }
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
    if (cursor >= program.length) break;
    literals.push(body);
    const interpolated = INLINE_INTERPOLATION.test(body) || (language === 'python' && /[fF][rRbB]?$|[rRbB][fF]$/.test(program.slice(Math.max(0, index - 2), index)) && body.includes('{'));
    const named = INLINE_NAMING_CONTEXT.test(code.slice(-120));
    let inner = named ? body : '';
    if (interpolated && depth < 2) {
      const nested = scanProgram(body, language, depth + 1);
      literals.push(...nested.literals.slice(0, INLINE_MAX_LITERALS - literals.length));
      inner = nested.code;
    } else if (interpolated) inner = body;
    code += `${opening.executes ? opening.opener : ''} ${inner} `;
    index = cursor + 1;
  }
  return { literals, code };
}

// The inline program of a normalized command entry, or null when it runs none. `dynamic` is true when
// the program is not known before the command runs (`-c "$CODE"`, a word xargs supplies): the command
// is then ambiguous. Ruby and perl accept several `-e`, so every program word is kept.
export function inlineProgram(entry) {
  if (!entry?.tokens?.length) return null;
  const name = executableName(entry.tokens[0]);
  const known = INLINE_PROGRAM_OPTIONS.find(([executable]) => executable.test(name));
  if (!known) return null;
  const [, option, runs, toEnd, language] = known;
  const shellLike = !runs;
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
    index = first;
  }
  if (!parts.length) return null;
  const text = parts.join('\n');
  const { literals, code } = scanProgram(text, language);
  return { text, dynamic, shellLike, literals, runsCommands: shellLike || runs.test(code) };
}

// Normalized commands (the shape parseShellCommands returns) found in the inline program of `entry`.
// Candidates that do not parse are skipped: the literal was not a shell command. A literal that runs
// a shell without a static command (`sh`), or a program not known before the command runs, yields an
// `{ ambiguous: true }` entry.
export function inlineShellCommands(entry) {
  const program = inlineProgram(entry);
  if (!program) return [];
  if (program.dynamic) return [{ ambiguous: true, tokens: [], wrappers: entry.wrappers ?? [] }];
  if (!program.runsCommands) return [];
  const sources = [...(program.shellLike ? [program.text] : []), ...program.literals];
  const commands = [];
  for (const source of sources) {
    const parsed = parseShellCommands(source, 1, [...(entry.wrappers ?? []), executableName(entry.tokens[0])]);
    if (!parsed.error) commands.push(...parsed.commands.filter((command) => command.tokens?.length || command.ambiguous));
  }
  return commands;
}
