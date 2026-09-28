// Inline interpreter programs for the operation guards (shared block `inline`, which needs the
// `shell-items` and `capability` blocks): `python3 -c`, `node -e`, `deno eval`, `ruby -e`, `perl -e`,
// `php -r`. A program that can run a command (its language's execution primitives) has its string
// literals read as shell commands and judged by the hook's own capability; any finding is U, never the
// concrete rule, because the program may not run the string. A program known only at run time is an
// Unseen item of the parser, owned by shell-command-guard. Nothing is executed.
import { NOT_MINE, U, judgeItems, mentions } from './capability.mjs';
import { interpreterPrograms, parseShell } from './shell-items.mjs';

// Execution primitives per language: a program without one runs no command.
const INLINE_CAPABLE = {
  python: /\b(?:subprocess|pty|commands|system|popen\w*|spawn\w*|posix_spawn\w*|exec[lv]\w*|fork\w*|startfile|getattr|__import__|importlib|eval|exec|compile)\b/,
  js: /child_process|\b(?:execa|exec|execSync|execFile\w*|spawn\w*|fork|eval|require|Function)\b|\bimport\s*\(|\bprocess\s*\.\s*(?:binding|dlopen)\b|\bBun\s*\.\s*(?:spawn\w*|\$)|\$`|\bDeno\s*\.\s*(?:Command|run)\b/,
  ruby: /\b(?:system|exec|spawn|fork|syscall|open|popen\w*|Open3|PTY|Kernel|eval|instance_eval|class_eval|module_eval|send|public_send|__send__|method|constantize|const_get|require|load)\b|`|%x/,
  perl: /\b(?:system|exec|qx|open|readpipe|fork|eval|require)\b|IPC::|`/,
  php: /\b(?:exec|system|passthru|shell_exec|popen|proc_open|pcntl_exec|eval|assert|create_function|call_user_func\w*|include|require\w*)\b|`/
};
const INLINE_MAX_CANDIDATES = 256;

// Adjacent literals joined (`'a' 'b'`, `'a' + 'b'`, `'a' . 'b'`).
const join = (text) => text.replace(/(['"])\s*[+.]?\s*\1/g, '');
// String escapes decoded: `\xHH`, `\uHHHH`, `\x{…}`, `\u{…}`, `\o{…}`, octal, Python and Perl named
// characters (`\N{LATIN SMALL LETTER N}`, `\N{U+006E}`), and escaped characters. A name not listed
// here stays as written.
const CONTROL = { n: '\n', t: '\t', r: '\r' };
const DIGITS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
const NAMED = { SPACE: ' ', 'HYPHEN-MINUS': '-', 'FULL STOP': '.', SOLIDUS: '/', 'LOW LINE': '_', 'COMMERCIAL AT': '@', COLON: ':' };
function named(name) {
  const upper = name.trim().toUpperCase();
  const letter = /^LATIN (SMALL|CAPITAL) LETTER ([A-Z])$/.exec(upper);
  if (letter) return letter[1] === 'SMALL' ? letter[2].toLowerCase() : letter[2];
  const digit = /^DIGIT ([A-Z]+)$/.exec(upper);
  if (digit && DIGITS.includes(digit[1])) return String(DIGITS.indexOf(digit[1]));
  const code = /^U\+([0-9A-F]{1,6})$/.exec(upper);
  if (code) return String.fromCodePoint(Math.min(parseInt(code[1], 16), 0x10ffff));
  return NAMED[upper] ?? null;
}
function unescape(text) {
  return text.replace(/\\(?:N\{([^}]{1,64})\}|x\{([0-9a-f]+)\}|u\{([0-9a-f]+)\}|o\{([0-7]+)\}|x([0-9a-f]{2})|u([0-9a-f]{4})|([0-7]{1,3})|([\s\S]))/gi,
    (match, name, hexBrace, unicodeBrace, octalBrace, hex, unicode, octal, other) => {
      if (name !== undefined) return named(name) ?? match;
      if (other !== undefined) return CONTROL[other] ?? other;
      const code = parseInt(hexBrace ?? unicodeBrace ?? hex ?? unicode ?? octalBrace ?? octal, (octalBrace ?? octal) !== undefined ? 8 : 16);
      return String.fromCodePoint(Math.min(code, 0x10ffff));
    });
}

// Shell text candidates of a program: quoted literals, Perl and Ruby quote operators with any
// delimiter, and here-document bodies.
function candidates(text) {
  const found = [];
  for (const match of text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/gs)) found.push(match[2]);
  for (const match of text.matchAll(/(?:\b(?:qq|qx|qw|q)|%[qQxw]?)\s*(?:\{([^}]*)\}|\(([^)]*)\)|\[([^\]]*)\]|<([^>]*)>|([^\w\s])((?:(?!\5).)*)\5|\s([A-Za-z])((?:(?!\7).)*)\7)/gs)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[6] ?? match[8]);
  }
  for (const match of text.matchAll(/<<[~-]?\s*["']?(\w+)["']?[^\n]*\n([\s\S]*?)\n\s*\1\b/g)) found.push(match[2]);
  return found.filter(Boolean).slice(0, INLINE_MAX_CANDIDATES).map(unescape);
}

// A command name or path word of the hook in the program text: a word of 3 characters or more as a
// substring, a shorter one as a whole word.
function namesFamily(cap, text) {
  const lower = text.toLowerCase();
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const has = (word) => (word.length >= 3 ? lower.includes(word) : new RegExp(`(?:^|[^a-z0-9])${escape(word)}(?:$|[^a-z0-9])`).test(lower));
  return (cap.families ?? []).some((family) => family.executables.some(has) && (family.paths.every((path) => path.length === 0)
    || family.paths.some((path) => path.some((step) => step !== '*' && [].concat(step).some((word) => typeof word === 'string' && has(word.replace(/^\*|\*$/g, '')))))));
}

// U when a capable inline program of the command may run something the hook protects; NOT_MINE otherwise.
export function inlineVerdict(item, cap) {
  const found = interpreterPrograms(item);
  if (!found) return NOT_MINE;
  for (const program of found.programs) {
    if (program.text === undefined || !INLINE_CAPABLE[found.language].test(program.text)) continue;
    const text = join(program.text);
    const plain = unescape(text);
    if (mentions(cap, plain) || namesFamily(cap, plain)) return U;
    if (candidates(text).some((candidate) => judgeItems(parseShell(candidate), cap) !== NOT_MINE)) return U;
  }
  return NOT_MINE;
}
