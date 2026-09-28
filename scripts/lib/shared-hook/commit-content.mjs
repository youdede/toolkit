// What the `git commit` calls of a Bash command will take (shared block `commit-content`, which needs the
// `shell-items` and `capability` blocks): the `CommitIntent` record of hook-design 1.8 and the resolved
// Git calls it is built from. Nothing is executed; configured aliases are read once, one level deep.
// Edit it here and run `npm run shared-hooks`.
import { NOT_MINE, U, isStatic, judgeItems } from './capability.mjs';
import { parseShell } from './shell-items.mjs';

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

// Commit intent of a command (hook-design 1.8, capabilities.md C): `found` when a commit may run;
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
