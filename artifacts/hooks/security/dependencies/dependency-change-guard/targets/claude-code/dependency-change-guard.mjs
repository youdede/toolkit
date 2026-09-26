#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
// </youdede:shared>

// <youdede:shared commit-content>
// Shared "what will this command commit" analysis for Youdede hooks (shared block `commit-content`).
// scripts/generate-shared-hooks.mjs drops the import below and requires the `shell` block in the same
// hook. Edit it here and run `npm run shared-hooks`.

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
const COMMIT_MAX_ALIAS_DEPTH = 4;
const COMMIT_VALUE_OPTIONS = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '--author',
  '--date', '--fixup', '--squash', '-t', '--template', '--cleanup', '--trailer'
]);
const COMMIT_WORKTREE_OPTION = /^--(?:all|include|only|interactive|patch|pathspec-from-file(?:=.*)?)$/;
const SHORT_WORKTREE_FLAGS = new Set(['a', 'i', 'o', 'p']);
const SHORT_VALUE_NEXT = new Set(['m', 'F', 'C', 'c', 't']);
const SHORT_VALUE_ATTACHED = new Set(['S', 'u']);
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);

// Walks the options of `git commit` args, which Git parses before and after pathspecs; `visit(flag)`
// sees each long option and each short flag and returns true to stop. Words that xargs appends are
// unknown in number, so they count as a pathspec even where an option takes them as its value.
function walkCommitOptions(tokens, visit) {
  let pathspec = false;
  const takesValue = (index) => { if (tokens[index]?.placeholder) pathspec = true; };
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === '--') return { stopped: false, pathspec: pathspec || index + 1 < tokens.length };
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
export function commitReadsWorkingTree(tokens) {
  const walked = walkCommitOptions(tokens, (flag) => COMMIT_WORKTREE_OPTION.test(flag) || (flag.length === 2 && SHORT_WORKTREE_FLAGS.has(flag[1])));
  return walked.stopped || walked.pathspec;
}

// True when the commit skips the repository's hooks: -n in any short-option group, or
// --no-verify and its unambiguous abbreviations.
export function commitSkipsHooks(tokens) {
  return walkCommitOptions(tokens, (flag) => flag === '-n' || /^--no-v(?:e(?:r(?:i(?:fy?)?)?)?)?$/.test(flag)).stopped;
}

// `git add -f` / `git stage --force`: the ignored paths it names, or `all` when they are unknown.
function forcedAdd(args) {
  let forced = false;
  let all = false;
  let options = true;
  const pathspecs = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.dynamic || token.placeholder) { all = true; continue; }
    const value = token.value;
    if (options && value === '--') { options = false; continue; }
    if (options && value.startsWith('-')) {
      if (/^--for(?:ce?)?$/.test(value) || (/^-[A-Za-z]+$/.test(value) && value.includes('f'))) forced = true;
      else if (value.startsWith('--pathspec-from-file')) { all = true; if (!value.includes('=')) index += 1; }
      continue;
    }
    pathspecs.push(value);
  }
  return forced ? { all: all || pathspecs.length === 0, pathspecs } : null;
}

// `git config [set] [options] alias.<name> <value>`: [name, value], value null when dynamic.
function aliasDefinition(args) {
  const positional = [];
  for (let index = args[0]?.value === 'set' ? 1 : 0; index < args.length && positional.length < 2; index += 1) {
    const token = args[index];
    if (!token.dynamic && !token.placeholder && token.value.startsWith('-') && positional.length === 0) {
      if (CONFIG_VALUE_OPTIONS.has(token.value)) index += 1;
      continue;
    }
    positional.push(token);
  }
  const [key, value] = positional;
  if (!key || !value) return null;
  if (key.dynamic || key.placeholder) return ['*', null];
  if (!/^alias\./i.test(key.value)) return null;
  return [key.value.slice('alias.'.length).toLowerCase(), value.dynamic || value.placeholder ? null : value.value];
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

function aliasValue(name, invocation, state) {
  let value;
  for (const setting of invocation.globals.config) if (setting.key === `alias.${name}`) value = setting.value;
  if (value !== undefined) return value;
  if (state.localAliases.has(name)) return state.localAliases.get(name);
  if (state.localAliases.has('*')) return null;
  if (state.configured === undefined) {
    const source = state.aliases;
    state.configured = typeof source === 'function' ? source() : source instanceof Map ? source : new Map();
  }
  return state.configured.get(name);
}

function inspectGit(tokens, changedDirectory, state, depth) {
  const invocation = gitInvocation(tokens);
  if (invocation.ambiguous) return false;
  const { name, args } = invocation;
  if (!name) return true;
  if (!GIT_BUILTINS.has(name)) {
    const alias = aliasValue(name, invocation, state);
    // Not an alias: an external `git-<name>` program, which this analysis does not follow.
    if (alias === undefined) return true;
    if (alias === null || depth >= COMMIT_MAX_ALIAS_DEPTH) return false;
    if (alias.startsWith('!')) {
      // Git runs a shell alias with the arguments appended, from the top of the work tree.
      const nested = parseShellCommands(alias.slice(1));
      if (nested.error) return false;
      const last = nested.commands.at(-1);
      if (last?.tokens) last.tokens = [...last.tokens, ...args];
      for (const entry of nested.commands) entry.changedDirectory = true;
      return walk(nested.commands, state, depth + 1);
    }
    const expansion = parseShellCommands(`git ${alias}`);
    if (expansion.error || expansion.commands.length !== 1 || !expansion.commands[0].tokens) return false;
    const expanded = [tokens[0], ...tokens.slice(1, invocation.index), ...expansion.commands[0].tokens.slice(1), ...args];
    return inspectGit(expanded, changedDirectory, state, depth + 1);
  }
  if (name === 'config') {
    const definition = aliasDefinition(args);
    if (definition) state.localAliases.set(definition[0], definition[1]);
    return true;
  }
  if (name === 'commit') {
    state.found = true;
    state.unsupportedScope ||= changedDirectory || invocation.scoped;
    state.worktree ||= state.stagedEarlier || commitReadsWorkingTree(args);
    state.noVerify ||= commitSkipsHooks(args) || invocation.globals.config.some((setting) => setting.key === 'core.hookspath');
    return true;
  }
  if (COMMIT_STAGING_SUBCOMMANDS.has(name)) {
    state.stagedEarlier = true;
    const forced = (name === 'add' || name === 'stage') ? forcedAdd(args) : null;
    if (forced) {
      state.ignored ??= { all: false, pathspecs: [] };
      state.ignored.all ||= forced.all;
      state.ignored.pathspecs.push(...forced.pathspecs);
    }
  }
  return true;
}

function walk(commands, state, depth) {
  for (const entry of commands) {
    if (entry.ambiguous) return false;
    if (!entry.tokens?.length || executableName(entry.tokens[0]) !== 'git') continue;
    if (!inspectGit(entry.tokens, entry.changedDirectory, state, depth)) return false;
  }
  return true;
}

// What the `git commit` calls in a shell command will take. Returns { ambiguous: true } when the
// command cannot be analyzed, else { found, unsupportedScope, worktree, noVerify, ignored }:
// - unsupportedScope: a commit runs after cd/pushd or with -C/--git-dir/--work-tree;
// - worktree: a commit can take working-tree content (staged earlier in the command, -a, pathspec);
// - noVerify: a commit skips repository hooks (-n, --no-verify, -c core.hooksPath=…);
// - ignored: null, or { all, pathspecs } of ignored files that `git add -f` stages.
// `options.aliases` is a Map or a function returning one (read lazily, for example with
// readGitAliases); aliases defined in the command itself and by `git -c alias.x=…` win.
export function analyzeCommitContent(command, options = {}) {
  const parsed = parseShellCommands(command);
  if (parsed.error) return { ambiguous: true };
  const state = {
    aliases: options.aliases, configured: undefined, localAliases: new Map(),
    found: false, unsupportedScope: false, worktree: false, noVerify: false, stagedEarlier: false, ignored: null
  };
  if (!walk(parsed.commands, state, 0)) return { ambiguous: true };
  const { found, unsupportedScope, worktree, noVerify, ignored } = state;
  return { found, unsupportedScope, worktree, noVerify, ignored };
}
// </youdede:shared>

function cleanGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_GIT_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_STAGED_PATHS = 4000;
export const MAX_COMMAND_BYTES = SHELL_MAX_COMMAND_BYTES;

const PACKAGE_EXECUTABLES = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'composer']);

// Kept for callers of the previous export: the shared shell analysis.
export function normalizeShellCommands(command) {
  return parseShellCommands(command);
}

const COMMAND_START = String.raw`(?:^|[;&|()]\s*)`;

const COMMAND_RULES = [
  {
    id: 'dependency-resolution-bypass',
    reason: 'the package-manager command explicitly bypasses dependency or platform resolution safeguards',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:sudo|command)\s+)*(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update|up|upgrade|ci)\b[^;&|\n]*(?:--force|--legacy-peer-deps)(?:\s|=|$)|composer\s+(?:install|update|require)\b[^;&|\n]*--ignore-platform-reqs?(?:\s|=|$))`, 'm')
  },
  {
    id: 'lockfile-generation-bypass',
    reason: 'the package-manager command explicitly disables lockfile use or generation',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:sudo|command)\s+)*(?:(?:npm|yarn)\s+(?:i|install|add|update|up|upgrade|ci)\b[^;&|\n]*(?:--no-package-lock|--package-lock(?:=|\s+)false|--no-lockfile)(?:\s|$)|pnpm\s+(?:i|install|add|update|up)\b[^;&|\n]*(?:--no-lockfile|--lockfile(?:=|\s+)false)(?:\s|$))`, 'm')
  },
  {
    id: 'insecure-package-transport',
    reason: 'the dependency command explicitly weakens package transport verification',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:sudo|command)\s+)*(?:pip(?:3)?\s+install\b[^;&|\n]*(?:--trusted-host(?:\s|=)|(?:-i\s*|--index-url(?:\s|=)|--extra-index-url(?:\s|=))http:)|(?:npm|yarn|pnpm)\s+config\s+set\s+(?:strict-ssl\s+false|registry\s+http:))`, 'mi')
  }
];

const LOCKFILE_BASENAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'composer.lock', 'cargo.lock', 'poetry.lock', 'uv.lock', 'gemfile.lock', 'go.sum'
]);

const MANIFEST_LOCKS = new Map([
  ['package.json', ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']],
  ['composer.json', ['composer.lock']],
  ['cargo.toml', ['Cargo.lock']],
  ['pyproject.toml', ['poetry.lock', 'uv.lock']],
  ['gemfile', ['Gemfile.lock']],
  ['go.mod', ['go.sum']]
]);

function normalizeRelative(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function git(args, cwd, allowMissing = false) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: MAX_GIT_BUFFER_BYTES,
    env: cleanGitEnvironment()
  });
  if (result.error || result.status !== 0) {
    if (allowMissing && result.status !== null) return null;
    const detail = String(result.stderr || result.error?.message || 'unknown Git error').trim().slice(0, 300);
    throw new Error(detail);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
}

function readGitBlob(spec, cwd, allowMissing = false) {
  const blob = git(['show', spec], cwd, allowMissing);
  if (blob === null) return null;
  if (blob.length > MAX_MANIFEST_BYTES) throw new Error(`manifest blob exceeds ${MAX_MANIFEST_BYTES} bytes`);
  if (blob.includes(0)) throw new Error('manifest blob is binary');
  return blob.toString('utf8');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function tomlDependencyFingerprint(content, manifestName) {
  if (manifestName === 'cargo.toml') {
    return content.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, '').trim()).filter(Boolean).join('\n');
  }
  const wanted = /^(?:project|dependency-groups|tool\.poetry\.(?:group\.[^.]+\.)?dependencies|tool\.uv\.(?:sources|dependency-metadata))(?:\.|$)/i;
  let section = '';
  const selected = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      if (wanted.test(section)) selected.push(`[${section}]`);
      continue;
    }
    if (wanted.test(section) && line) selected.push(line);
    if (manifestName === 'pyproject.toml' && /^dependencies\s*=/.test(line) && section === 'project') selected.push(line);
  }
  return selected.join('\n');
}

export function dependencyFingerprint(manifestName, content) {
  const lower = manifestName.toLowerCase();
  if (lower === 'package.json') {
    const parsed = JSON.parse(content || '{}');
    const selected = {};
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions', 'packageManager']) {
      if (Object.hasOwn(parsed, key)) selected[key] = parsed[key];
    }
    return stableJson(selected);
  }
  if (lower === 'composer.json') {
    const parsed = JSON.parse(content || '{}');
    const selected = {};
    for (const key of ['require', 'require-dev', 'conflict', 'replace', 'provide', 'repositories', 'minimum-stability', 'prefer-stable']) {
      if (Object.hasOwn(parsed, key)) selected[key] = parsed[key];
    }
    return stableJson(selected);
  }
  if (lower === 'cargo.toml' || lower === 'pyproject.toml') return tomlDependencyFingerprint(content, lower);
  if (lower === 'gemfile' || lower === 'go.mod') {
    return content.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, '').trim()).filter(Boolean).join('\n');
  }
  return '';
}

function findNearestLocks(projectRoot, manifestPath, names) {
  let directory = path.posix.dirname(manifestPath);
  const found = [];
  for (let depth = 0; depth < 32; depth += 1) {
    for (const name of names) {
      const relative = directory === '.' ? name : `${directory}/${name}`;
      try {
        lstatSync(path.join(projectRoot, ...relative.split('/')));
        found.push(relative);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (found.length || directory === '.') break;
    directory = path.posix.dirname(directory);
  }
  return found;
}

// Paths a working-tree commit can take besides the index: tracked files with unstaged changes,
// untracked non-ignored files, and the ignored files `git add -f` names.
function worktreePaths(projectRoot, ignored) {
  const listed = git(['ls-files', '-z', '--modified', '--others', '--exclude-standard', '--full-name', ':/'], projectRoot).toString('utf8');
  const forced = ignored ? git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--full-name', '--', ...(ignored.all ? [':/'] : ignored.pathspecs)], projectRoot).toString('utf8') : '';
  return new Set(`${listed}\0${forced}`.split('\0').filter(Boolean).map(normalizeRelative));
}

function readWorktreeFile(top, relative) {
  const absolute = path.join(top, ...relative.split('/'));
  const stat = lstatSync(absolute);
  if (!stat.isFile()) throw new Error('manifest is not a regular file');
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  const data = readFileSync(absolute);
  if (data.includes(0)) throw new Error('manifest is binary');
  return data.toString('utf8');
}

// Manifests the commit can take are a superset (index plus, for a working-tree commit, changed
// working-tree files). A lockfile counts as committed when it is staged or, for a working-tree
// commit, changed in the working tree. ponytail: `git add package.json && git commit` beside an
// unstaged regenerated lockfile passes; telling it apart needs the pathspecs of `git add`.
function collectCommitEntries(projectRoot, intent) {
  const top = git(['rev-parse', '--show-toplevel'], projectRoot).toString('utf8').trim();
  const rawNames = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], top);
  const stagedPaths = rawNames.toString('utf8').split('\0').filter(Boolean).map(normalizeRelative);
  const worktree = intent.worktree ? worktreePaths(projectRoot, intent.ignored) : new Set();
  if (stagedPaths.length + worktree.size > MAX_STAGED_PATHS) throw new Error(`staged path count exceeds ${MAX_STAGED_PATHS}`);
  const staged = new Set(stagedPaths);
  const committedLock = (lock) => staged.has(lock) || worktree.has(lock);
  const entries = [];

  for (const manifest of new Set([...stagedPaths, ...worktree])) {
    const manifestName = path.posix.basename(manifest);
    const lockNames = MANIFEST_LOCKS.get(manifestName.toLowerCase());
    if (!lockNames) continue;
    const locks = findNearestLocks(top, manifest, lockNames);
    if (locks.length === 0) continue;
    try {
      if (worktree.has(manifest) && !existsSync(path.join(top, ...manifest.split('/')))) continue;
      const current = worktree.has(manifest) ? readWorktreeFile(top, manifest) : readGitBlob(`:${manifest}`, top);
      const previous = readGitBlob(`HEAD:${manifest}`, top, true) || '';
      entries.push({
        manifest,
        locks,
        lockStaged: locks.some(committedLock),
        dependencyChanged: dependencyFingerprint(manifestName, current) !== dependencyFingerprint(manifestName, previous)
      });
    } catch (error) {
      entries.push({ manifest, locks, inspectionError: error.message });
    }
  }
  return entries;
}

export function collectContext(input, cwd = process.cwd()) {
  const projectRoot = path.resolve(input?.cwd || cwd);
  const rawPath = input?.tool_input?.file_path || input?.tool_input?.file;
  let relative = null;
  if (typeof rawPath === 'string' && rawPath) {
    // The lockfile rule reads the file name, so a lockfile outside the current directory (a
    // monorepo root after `cd pkg`) is still recognized.
    const absolute = path.resolve(projectRoot, rawPath);
    const candidate = normalizeRelative(path.relative(projectRoot, absolute));
    relative = candidate !== '..' && !candidate.startsWith('../') && !path.isAbsolute(candidate) ? candidate : normalizeRelative(absolute);
  }

  const command = input?.tool_input?.command;
  let commitEntries;
  let commitError;
  let commitIntent;
  try {
    commitIntent = typeof command === 'string'
      ? analyzeCommitContent(command, { aliases: () => readGitAliases((args) => spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', timeout: 10_000, env: cleanGitEnvironment() })) })
      : { found: false };
  } catch (error) {
    commitIntent = { found: false };
    commitError = error.message;
  }
  if (commitIntent.found && !commitIntent.unsupportedScope) {
    try {
      commitEntries = collectCommitEntries(projectRoot, commitIntent);
    } catch (error) {
      commitError = error.message;
    }
  }
  return { relative, commitIntent, commitEntries, commitError };
}

export function evaluate(input, context = {}) {
  const command = input?.tool_input?.command;
  if (typeof command === 'string') {
    const normalized = parseShellCommands(command);
    const commitIntent = context.commitIntent ?? analyzeCommitContent(command);
    if (normalized.error || normalized.commands.some((entry) => entry.ambiguous) || commitIntent.ambiguous) {
      return { exitCode: 2, ruleId: 'dependency-command-uninspectable', message: 'BLOCKED by dependency-change-guard [dependency-command-uninspectable]: the shell command cannot be normalized safely.' };
    }
    const protectedDynamic = normalized.commands.some((entry) => entry.tokens?.length
      && PACKAGE_EXECUTABLES.has(executableName(entry.tokens[0]))
      && entry.tokens.slice(1).some((token) => token.dynamic));
    const commandRule = normalized.commands
      .map((entry) => entry.tokens?.map((token) => token.value).join(' ') || '')
      .flatMap((candidate) => COMMAND_RULES.filter((ruleCandidate) => ruleCandidate.pattern.test(candidate)))
      .at(0);
    if (!commandRule && protectedDynamic) {
      return { exitCode: 2, ruleId: 'dependency-command-uninspectable', message: 'BLOCKED by dependency-change-guard [dependency-command-uninspectable]: a package-manager command uses dynamic control arguments.' };
    }
    if (commandRule) {
      return {
        exitCode: 2,
        ruleId: commandRule.id,
        message: `BLOCKED by dependency-change-guard [${commandRule.id}]: ${commandRule.reason}. Use a reproducible package-manager operation without bypass flags.`
      };
    }
    if (!commitIntent.found) return { exitCode: 0, message: '' };
    if (commitIntent.unsupportedScope) {
      return {
        exitCode: 2,
        ruleId: 'dependency-commit-scope-unsupported',
        message: 'BLOCKED by dependency-change-guard [dependency-commit-scope-unsupported]: dependency state cannot be verified when the commit command changes Git working context. Run the commit from that worktree directly.'
      };
    }
    if (context.commitError || (commitIntent.found && !context.commitEntries)) {
      return { exitCode: 2, ruleId: 'dependency-commit-inspection-failed', message: `BLOCKED by dependency-change-guard [dependency-commit-inspection-failed]: dependency state of the commit could not be verified (${context.commitError || 'not inspected'}).` };
    }
    for (const entry of context.commitEntries || []) {
      if (entry.inspectionError) {
        return { exitCode: 2, ruleId: 'dependency-manifest-inspection-failed', message: `BLOCKED by dependency-change-guard [dependency-manifest-inspection-failed]: ${entry.manifest} could not be compared (${entry.inspectionError}).` };
      }
      if (entry.dependencyChanged && !entry.lockStaged) {
        return {
          exitCode: 2,
          ruleId: 'dependency-lockfile-not-staged',
          message: `BLOCKED by dependency-change-guard [dependency-lockfile-not-staged]: ${entry.manifest} changes dependency state but its existing lockfile is not staged. Regenerate and stage the owning lockfile.`
        };
      }
    }
    return { exitCode: 0, message: '' };
  }

  if (!context.relative) return { exitCode: 0, message: '' };
  if (!LOCKFILE_BASENAMES.has(path.posix.basename(context.relative).toLowerCase())) return { exitCode: 0, message: '' };
  return {
    exitCode: 2,
    ruleId: 'dependency-lockfile-direct-edit',
    message: `BLOCKED by dependency-change-guard [dependency-lockfile-direct-edit]: ${context.relative} is a generated dependency lockfile. Use its package manager to regenerate it.`
  };
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error(`hook input exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error(`hook input is not valid JSON: ${error.message}`);
  }
}

async function main() {
  let result;
  try {
    const input = await readInput();
    result = evaluate(input, collectContext(input));
  } catch (error) {
    result = { exitCode: 2, message: `BLOCKED by dependency-change-guard [dependency-input-invalid]: ${error.message}.` };
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
