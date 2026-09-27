// Shell commands written inside an interpreter one-liner (shared block `inline-script`), such as
// `python3 -c "os.system('npm publish')"` or `cmd /c "sc stop x"`. scripts/generate-shared-hooks.mjs
// drops the import below and requires the `shell` block in the same hook. Edit it here and run
// `npm run shared-hooks`. Nothing is executed. A program that builds its command at run time, or passes
// it as an argument list, is not seen.
import { executableName, parseShellCommands } from './shell.mjs';

// Interpreter -> option that carries the inline program, as a separate word (`-c CODE`) or attached
// (`-cCODE`, `--eval=CODE`): group 1 is the attached program. Then the calls that run a command: only
// with one of them are the program's string literals read as commands, otherwise they are data. Last,
// whether the program runs to the end of the command line. cmd programs are shell-like (no call list),
// so the whole program is read as a command too. PowerShell is unwrapped by the `shell` block itself.
// ponytail: the call check is textual; a call name built at run time (getattr(os, 'sys' + 'tem')) is missed.
const INLINE_PROGRAM_OPTIONS = [
  [/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/, /^-[bBdEhiIOPqsSuvVxR]*c(.*)$/s,
    /\b(?:system|popen|subprocess|pty|spawn\w*|posix_spawn\w*|exec[lv]\w*)\b/, false],
  [/^(?:node|nodejs|bun)(?:\.exe)?$/, /^(?:-(?:pe|ep|e|p)=?|--eval=|--eval$|--print=|--print$)(.*)$/s,
    /child_process|\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\b|\bBun\s*\.\s*(?:spawn|spawnSync|\$)/, false],
  [/^deno(?:\.exe)?$/, /^(?:eval$|--eval$|--eval=)(.*)$/s, /\bDeno\s*\.\s*(?:Command|run)\b/, true],
  [/^ruby(?:\.exe)?$/, /^-[acdlnpsSvwyU]*e(.*)$/s,
    /\b(?:system|exec|spawn|popen\w*|Open3|PTY|open|syscall)\b|`|%x/, false],
  [/^perl(?:\.exe)?$/, /^-(?:[acfnpsStTuUvwWX]|l[0-7]*|0[0-7]*|0x[0-9A-Fa-f]*)*[eE](.*)$/s,
    /\b(?:system|exec|qx|open|readpipe)\b|`|%x/, false],
  [/^php(?:\.exe)?$/, /^(?:-[rBRE]|--(?:run|process-begin|process-code|process-end)(?:=|$))(.*)$/s,
    /\b(?:exec|system|passthru|shell_exec|popen|proc_open|pcntl_exec)\b|`/, false],
  [/^cmd(?:\.exe)?$/, /^\/[cCkKrR](.*)$/s, null, true]
];
const INLINE_MAX_LITERALS = 256;

// Quoted string literals of a program, without their quotes; escapes keep the escaped character.
// Backticks count as quotes, and `%x(…)`/`qx{…}` bodies as literals too. One pass: an unterminated
// literal ends the scan.
function stringLiterals(program) {
  const literals = [];
  let literal = null;
  let quote = null;
  for (let index = 0; index < program.length && literals.length < INLINE_MAX_LITERALS; index += 1) {
    const character = program[index];
    if (!quote) {
      if (character === "'" || character === '"' || character === '`') { quote = character; literal = ''; }
      continue;
    }
    if (character === '\\') { index += 1; literal += program[index] ?? ''; }
    else if (character === quote) { literals.push(literal); quote = null; }
    else literal += character;
  }
  for (const match of program.matchAll(/(?:%x|\bqx)\s*(?:\(([^)]*)\)|\{([^}]*)\}|\[([^\]]*)\]|<([^>]*)>)/g)) {
    if (literals.length >= INLINE_MAX_LITERALS) break;
    literals.push(match.slice(1).find((body) => body !== undefined));
  }
  return literals;
}

// The inline program of a normalized command entry, or null when it runs none. `dynamic` is true when
// the program is not known before the command runs (`-c "$CODE"`, a word xargs supplies): the command
// is then ambiguous. Ruby and perl accept several `-e`, so every program word is kept.
export function inlineProgram(entry) {
  if (!entry?.tokens?.length) return null;
  const name = executableName(entry.tokens[0]);
  const known = INLINE_PROGRAM_OPTIONS.find(([executable]) => executable.test(name));
  if (!known) return null;
  const [, option, runs, toEnd] = known;
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
  return { text: parts.join('\n'), dynamic, shellLike, runsCommands: shellLike || runs.test(parts.join('\n')) };
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
  const sources = [...(program.shellLike ? [program.text] : []), ...stringLiterals(program.text)];
  const commands = [];
  for (const source of sources) {
    const parsed = parseShellCommands(source, 1, [...(entry.wrappers ?? []), executableName(entry.tokens[0])]);
    if (!parsed.error) commands.push(...parsed.commands.filter((command) => command.tokens?.length || command.ambiguous));
  }
  return commands;
}
