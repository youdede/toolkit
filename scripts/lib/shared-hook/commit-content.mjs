// Shared "what will this command commit" analysis for Youdede hooks (shared block `commit-content`).
// scripts/generate-shared-hooks.mjs drops the import below and requires the `shell` block in the same
// hook. Edit it here and run `npm run shared-hooks`.
import { executableName, gitInvocation, parseShellCommands } from './shell.mjs';

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
