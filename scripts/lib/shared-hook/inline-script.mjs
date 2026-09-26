// Shell commands written inside an interpreter one-liner (shared block `inline-script`), such as
// `python3 -c "os.system('npm publish')"` or `cmd /c "sc stop x"`. scripts/generate-shared-hooks.mjs
// drops the import below and requires the `shell` block in the same hook. Edit it here and run
// `npm run shared-hooks`. Nothing is executed. A program that builds its command at run time, or passes
// it as an argument list, is not seen.
import { executableName, parseShellCommands } from './shell.mjs';

// Interpreter -> option that takes the inline program. cmd programs are shell-like, so the whole program
// is read as a command too; for the others only quoted string literals are. PowerShell is unwrapped by
// the `shell` block itself.
const INLINE_PROGRAM_OPTIONS = [
  [/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/, /^-[A-Za-z]*c$/, false],
  [/^(?:node|nodejs|bun)(?:\.exe)?$/, /^(?:-e|--eval|-p|--print)$/, false],
  [/^deno(?:\.exe)?$/, /^eval$/, false],
  [/^(?:ruby|perl)(?:\.exe)?$/, /^-[A-Za-z]*[eE]$/, false],
  [/^php(?:\.exe)?$/, /^-r$/, false],
  [/^cmd(?:\.exe)?$/, /^\/[cCkK]$/, true]
];
const INLINE_MAX_LITERALS = 256;

// Quoted string literals of a program, without their quotes; escapes keep the escaped character.
// One pass: an unterminated literal ends the scan.
function stringLiterals(program) {
  const literals = [];
  let literal = null;
  let quote = null;
  for (let index = 0; index < program.length && literals.length < INLINE_MAX_LITERALS; index += 1) {
    const character = program[index];
    if (!quote) {
      if (character === "'" || character === '"') { quote = character; literal = ''; }
      continue;
    }
    if (character === '\\') { index += 1; literal += program[index] ?? ''; }
    else if (character === quote) { literals.push(literal); quote = null; }
    else literal += character;
  }
  return literals;
}

// The inline program of a normalized command entry, or null when it runs none.
export function inlineProgram(entry) {
  if (!entry?.tokens?.length) return null;
  const name = executableName(entry.tokens[0]);
  const known = INLINE_PROGRAM_OPTIONS.find(([executable]) => executable.test(name));
  if (!known) return null;
  const position = entry.tokens.findIndex((token, index) => index > 0 && known[1].test(token.value));
  const program = position > 0 ? entry.tokens[position + 1] : null;
  if (!program) return null;
  // A PowerShell or cmd program continues to the end of the command line.
  const text = known[2] ? entry.tokens.slice(position + 1).map((token) => token.value).join(' ') : program.value;
  return { text, dynamic: program.dynamic || Boolean(program.placeholder), shellLike: known[2] };
}

// Normalized commands (the shape parseShellCommands returns) found in the inline program of `entry`.
// Candidates that do not parse are skipped: the literal was not a shell command.
export function inlineShellCommands(entry) {
  const program = inlineProgram(entry);
  if (!program) return [];
  const sources = [...(program.shellLike ? [program.text] : []), ...stringLiterals(program.text)];
  const commands = [];
  for (const source of sources) {
    const parsed = parseShellCommands(source, 1, [...(entry.wrappers ?? []), executableName(entry.tokens[0])]);
    if (!parsed.error) commands.push(...parsed.commands.filter((command) => command.tokens?.length));
  }
  return commands;
}
