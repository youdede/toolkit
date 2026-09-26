// Shared shell analysis for Youdede Bash hooks (shared block `shell`). Hooks stay single-file:
// scripts/generate-shared-hooks.mjs copies this file into each hook between the block markers. Edit it
// here and run `npm run shared-hooks`; tests/shared-hook-shell.test.mjs holds the probes every hook shares.
// Nothing is executed. Every loop advances its index or is capped, and nested shells stop at depth 3.

export const SHELL_MAX_COMMAND_BYTES = 256 * 1024;
const SHELL_MAX_DEPTH = 3;
const SHELL_MAX_WRAPPERS = 16;
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHELL_WRAPPERS = new Set(['exec', 'time', 'noglob', 'command', 'env', 'sudo', 'nohup', 'nice', 'timeout', 'xargs']);
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
  time: { next: /^(?:-f|-o|--format|--output)$/, alone: /^(?:-a|-p|-v|--append|--portability|--verbose|--quiet|--format=.+|--output=.+)$/ },
  exec: { next: /^-a$/, alone: /^(?:-c|-l)$/ },
  command: { alone: /^-p$/ },
  noglob: {},
  nohup: {},
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
  let depth = 1;
  let quote = null;
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') { index += 1; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === open) depth += 1;
    else if (character === close && --depth === 0) return index + 1;
  }
  return -1;
}

// Splits source into segments of tokens. Quotes and escapes are removed; expansions stay as text and
// mark the token dynamic. `operator` is the one that ends the segment: `&&`, `||`, `;`, `|`, `&`,
// `\n`, `(`, `)`, or '' at the end.
function lexShell(source) {
  const segments = [];
  let tokens = [];
  let token = null;
  let quote = null;
  const begin = () => { if (!token) token = { value: '', dynamic: false }; };
  const pushToken = () => {
    if (!token) return;
    // Only `{a,b}` and `{x..y}` expand; `{}` and `stash@{0}` are literal.
    if (token.braces && /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(token.value)) token.dynamic = true;
    delete token.braces;
    tokens.push(token);
    token = null;
  };
  const pushSegment = (operator) => { pushToken(); if (tokens.length) segments.push({ tokens, operator }); tokens = []; };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") { if (character === "'") quote = null; else token.value += character; continue; }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') { if (++index >= source.length) return { error: 'trailing escape' }; token.value += source[index]; }
      else if (character === '$' || character === '`') {
        const end = expansionEnd(source, index);
        if (end < 0) return { error: 'unterminated expansion' };
        token.value += source.slice(index, end); token.dynamic = true; index = end - 1;
      } else token.value += character;
      continue;
    }
    if (/\s/.test(character)) { pushToken(); if (character === '\n') pushSegment('\n'); }
    else if (character === "'" || character === '"') { begin(); quote = character; }
    else if (character === '\\') { begin(); if (++index >= source.length) return { error: 'trailing escape' }; token.value += source[index]; }
    else if (character === '$' || character === '`' || ((character === '<' || character === '>') && source[index + 1] === '(')) {
      begin();
      const end = expansionEnd(source, index);
      if (end < 0) return { error: 'unterminated expansion' };
      token.value += source.slice(index, end); token.dynamic = true; index = end - 1;
    } else if (character === '&' && (/[<>]$/.test(token?.value ?? '') || source[index + 1] === '>')) {
      // `2>&1`, `>&2`, `&>file`: a redirection, not a command separator.
      begin(); token.value += character;
    } else if (';&|()'.includes(character)) {
      let operator = character;
      if ((character === '&' || character === '|') && source[index + 1] === character) { operator += character; index += 1; }
      pushSegment(operator);
    } else { begin(); token.value += character; if (character === '{' || character === '}') token.braces = true; }
  }
  if (quote) return { error: 'unterminated quote' };
  pushSegment('');
  return { segments };
}

export function executableName(token) {
  return token.value.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
}

// Commands that find runs through -exec/-execdir/-ok/-okdir, with `{}` as a placeholder.
function findActions(tokens, depth, wrappers) {
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
    if (inner.length) entries.push(...unwrapCommand(inner, depth, [...wrappers, 'find']));
    index = end + 1;
  }
  return entries;
}

function unwrapCommand(original, depth, inherited = []) {
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
  for (let count = 0; count < SHELL_MAX_WRAPPERS && index < tokens.length; count += 1) {
    const executable = tokens[index];
    if (executable.dynamic || executable.placeholder || /[*?]|\[[^\]]*\]/.test(executable.value)) return ambiguous();
    const name = executableName(executable);
    if (SHELL_NAMES.has(name) || name === 'eval') {
      let payload = name === 'eval' ? index + 1 : -1;
      if (name !== 'eval') {
        for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
          const option = tokens[cursor];
          if (option.dynamic || option.placeholder) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
          if (option.value === '-c' || option.value === '--command' || /^-[^-]*c[^-]*$/.test(option.value)) { payload = cursor + 1; break; }
          // `-o option`, `+O shopt`: the next token is the option name, not a script.
          if (/^[-+][oO]$/.test(option.value)) { cursor += 1; continue; }
          if (!/^[-+]./.test(option.value)) break;
        }
        if (payload < 0) return [{ tokens: tokens.slice(index), wrappers }];
      }
      if (!tokens[payload] || depth >= SHELL_MAX_DEPTH) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
      const inner = name === 'eval' ? tokens.slice(payload).map((entry) => entry.value).join(' ') : tokens[payload].value;
      const nested = parseShellCommands(inner, depth + 1, [...wrappers, name]);
      if (nested.error) return [{ ambiguous: true, wrappers: [...wrappers, name] }];
      return nested.commands;
    }
    if (name === 'find') return [{ tokens: tokens.slice(index), wrappers }, ...findActions(tokens.slice(index), depth, wrappers)];
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
    if (name === 'timeout') {
      // The duration comes first; `timeout` without one runs nothing.
      if (!tokens[index] || tokens[index].dynamic) return ambiguous();
      index += 1;
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
// `a && b` runs b only if a succeeded while `a; b` runs b anyway. Wrappers (sudo, env, nice,
// timeout, xargs, exec, time, noglob, command, nohup) and static `sh -c`/`bash -c`/`eval` layers
// are removed; `find -exec` adds the command it runs. `changedDirectory` is true after cd, pushd,
// or popd in the same command. An ambiguous entry carries `segment`, the tokens of the innermost
// segment it came from, so a hook can still judge that segment's text.
export function parseShellCommands(command, depth = 0, wrappers = []) {
  if (typeof command !== 'string') return { commands: [] };
  if (Buffer.byteLength(command, 'utf8') > SHELL_MAX_COMMAND_BYTES) return { error: 'command exceeds analysis limit', commands: [] };
  const lexed = lexShell(command);
  if (lexed.error) return { error: lexed.error, commands: [] };
  const commands = [];
  for (const segment of lexed.segments) {
    const entries = unwrapCommand(segment.tokens, depth, wrappers);
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
