#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
export const GIT_TIMEOUT_MS = 3000;
const NATIVE_MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SIMPLE_WRAPPERS = new Set(['exec', 'command', 'time', 'noglob', 'env', 'sudo', 'nohup', 'nice', 'timeout']);
const HISTORY_MUTATIONS = new Set(['commit', 'merge', 'rebase', 'reset', 'cherry-pick', 'revert', 'am']);
const RECOVERY_FLAGS = new Set(['--abort', '--quit']);
function toolName(input) {
  const value = input?.tool_name ?? input?.toolName;
  return typeof value === 'string' ? value : '';
}
function toolPayload(input) {
  const value = input?.tool_input ?? input?.toolInput;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function commandFrom(input) {
  const value = toolPayload(input)?.command;
  return typeof value === 'string' ? value : '';
}
function executable(token) {
  return token.value.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
}
function readExpansion(source, start) {
  if (source[start] === '`') {
    for (let index = start + 1; index < source.length; index += 1) {
      if (source[index] === '\\') index += 1;
      else if (source[index] === '`') return index + 1;
    }
    return -1;
  }
  if (source[start + 1] !== '(' && source[start + 1] !== '{') {
    const matched = /^\$[A-Za-z_][A-Za-z0-9_]*|^\$[0-9@*#?$!_-]/.exec(source.slice(start));
    return matched ? start + matched[0].length : start + 1;
  }
  const opening = source[start + 1];
  const closing = opening === '(' ? ')' : '}';
  let depth = 1;
  let quote = null;
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') { index += 1; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === opening) depth += 1;
    if (character === closing && --depth === 0) return index + 1;
  }
  return -1;
}

function tokenizeShell(source) {
  const invocations = [];
  let tokens = [];
  let current = null;
  let quote = null;
  const begin = () => { if (!current) current = { value: '', dynamic: false }; };
  const finishToken = () => { if (current) tokens.push(current); current = null; };
  const finishInvocation = () => { finishToken(); if (tokens.length) invocations.push(tokens); tokens = []; };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else current.value += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') {
        index += 1;
        if (index >= source.length) return { error: 'trailing escape' };
        current.value += source[index];
      } else if (character === '$' || character === '`') {
        const end = readExpansion(source, index);
        if (end < 0) return { error: 'unterminated expansion' };
        current.value += source.slice(index, end);
        current.dynamic = true;
        index = end - 1;
      } else current.value += character;
      continue;
    }
    if (/\s/.test(character)) {
      finishToken();
      if (character === '\n') finishInvocation();
      continue;
    }
    if (character === "'" || character === '"') { begin(); quote = character; continue; }
    if (character === '\\') {
      begin();
      index += 1;
      if (index >= source.length) return { error: 'trailing escape' };
      current.value += source[index];
      continue;
    }
    if (character === '$' || character === '`') {
      begin();
      const end = readExpansion(source, index);
      if (end < 0) return { error: 'unterminated expansion' };
      current.value += source.slice(index, end);
      current.dynamic = true;
      index = end - 1;
      continue;
    }
    if (';&|()'.includes(character)) {
      finishInvocation();
      if ((character === '&' || character === '|') && source[index + 1] === character) index += 1;
      continue;
    }
    begin();
    current.value += character;
    if ('{}*?['.includes(character)) current.dynamic = true;
  }
  if (quote) return { error: 'unterminated quote' };
  finishInvocation();
  return { invocations };
}

function optionConsumesValue(wrapper, option) {
  if (wrapper === 'sudo') return /^(?:-u|-g|-h|-p|-C|-T|-r|-t|--user|--group|--host|--prompt|--close-from|--command-timeout|--role|--type)$/.test(option);
  if (wrapper === 'time') return /^(?:-f|-o|--format|--output)$/.test(option);
  if (wrapper === 'nice') return /^(?:-n|--adjustment)$/.test(option);
  if (wrapper === 'exec') return option === '-a';
  return false;
}
function unwrap(tokens, depth) {
  let index = 0;
  for (let count = 0; count < 16 && index < tokens.length; count += 1) {
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index].value)) {
      if (tokens[index].dynamic || /^GIT_[A-Za-z0-9_]*=/.test(tokens[index].value)) return { ambiguous: true };
      index += 1;
    }
    if (index >= tokens.length) return { invocation: [] };
    if (tokens[index].dynamic) return { ambiguous: true };
    const name = executable(tokens[index]);
    if (SHELLS.has(name) || name === 'eval') {
      if (depth >= 3) return { ambiguous: true };
      let payloadIndex = name === 'eval' ? index + 1 : -1;
      if (name !== 'eval') {
        for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
          if (tokens[cursor].dynamic) return { ambiguous: true };
          if (tokens[cursor].value === '-c' || tokens[cursor].value === '--command' || /^-[^-]*c[^-]*$/.test(tokens[cursor].value)) {
            payloadIndex = cursor + 1;
            break;
          }
          if (!tokens[cursor].value.startsWith('-')) break;
        }
        if (payloadIndex < 0) return { invocation: tokens.slice(index) };
      }
      const payload = tokens[payloadIndex];
      if (!payload || payload.dynamic) return { ambiguous: true };
      const nestedSource = name === 'eval'
        ? tokens.slice(payloadIndex).map((entry) => entry.value).join(' ')
        : payload.value;
      return normalizeShell(nestedSource, depth + 1);
    }

    if (!SIMPLE_WRAPPERS.has(name)) return { invocation: tokens.slice(index) };
    index += 1;
    if (name === 'command' && ['-v', '-V'].includes(tokens[index]?.value)) {
      return { invocation: tokens.slice(index - 1) };
    }
    while (index < tokens.length) {
      const option = tokens[index];
      if (option.dynamic) return { ambiguous: true };
      if (option.value === '--') { index += 1; break; }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(option.value)) {
        if (/^GIT_[A-Za-z0-9_]*=/.test(option.value)) return { ambiguous: true };
        index += 1;
        continue;
      }
      if (!option.value.startsWith('-')) break;
      if (name === 'env') {
        if (/^(?:-C|--chdir|-S|--split-string|-a|--argv0)(?:=|$)/.test(option.value)) return { ambiguous: true };
        if (/^(?:-u|--unset)$/.test(option.value)) { index += 2; continue; }
        if (/^(?:-u.+|--unset=.+|-i|--ignore-environment|-0|--null|-v|--debug)$/.test(option.value)) { index += 1; continue; }
        return { ambiguous: true };
      }
      if (name === 'sudo' && /^(?:-D|--chdir|-R|--chroot)(?:=|$)/.test(option.value)) return { ambiguous: true };
      if (optionConsumesValue(name, option.value)) { index += 2; continue; }
      const safeFlag = (name === 'sudo' && /^(?:-[AbEHKnS]+|--(?:askpass|background|preserve-env|edit|set-home|remove-timestamp|reset-timestamp|non-interactive|stdin|validate))$/.test(option.value))
        || (name === 'time' && /^(?:-a|-p|-v|--append|--portability|--verbose|--quiet|--format=.+|--output=.+)$/.test(option.value))
        || (name === 'exec' && /^(?:-c|-l)$/.test(option.value))
        || (name === 'command' && option.value === '-p');
      if (!safeFlag) return { ambiguous: true };
      index += 1;
    }
    if (name === 'timeout') {
      if (!tokens[index] || tokens[index].dynamic || !/^\d+(?:\.\d+)?[smhd]?$/.test(tokens[index].value)) return { ambiguous: true };
      index += 1;
    }
  }
  return index < tokens.length ? { ambiguous: true } : { invocation: [] };
}
export function normalizeShell(command, depth = 0) {
  if (typeof command !== 'string') return { invocations: [] };
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) return { error: 'command exceeds analysis limit', invocations: [] };
  const tokenized = tokenizeShell(command);
  if (tokenized.error) return { error: tokenized.error, invocations: [] };
  const invocations = [];
  for (const tokens of tokenized.invocations) {
    const result = unwrap(tokens, depth);
    if (result.ambiguous || result.error) return { error: 'command envelope is ambiguous', invocations: [] };
    if (result.invocations) invocations.push(...result.invocations);
    else if (result.invocation?.length) invocations.push(result.invocation);
  }
  return { invocations };
}
function parseGitInvocation(tokens) {
  if (!tokens.length || executable(tokens[0]) !== 'git') return null;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.dynamic) return { ambiguous: true };
    if (!token.value.startsWith('-')) break;
    if (token.value === '--') return { ambiguous: true };
    if (/^(?:-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/.test(token.value)) return { ambiguous: true };
    if (/^(?:-C.+|--(?:git-dir|work-tree|namespace|exec-path|config-env)=.+)$/.test(token.value)) return { ambiguous: true };
    if (token.value === '-c' || /^-c.+/.test(token.value)) return { ambiguous: true };
    if (!['--no-pager', '--paginate', '--no-replace-objects', '--literal-pathspecs', '--no-optional-locks'].includes(token.value)) {
      return { ambiguous: true };
    }
    index += 1;
  }
  const subcommand = tokens[index];
  if (!subcommand) return { subcommand: '', args: [] };
  if (subcommand.dynamic) return { ambiguous: true };
  return { subcommand: subcommand.value.toLowerCase(), args: tokens.slice(index + 1) };
}
function normalizedBranch(value, currentBranch = null) {
  let ref = value.replace(/^\+/, '');
  if (ref === 'HEAD' || ref === '@') return currentBranch;
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('heads/')) return ref.slice('heads/'.length);
  if (/^(?:refs\/)?tags\//.test(ref) || ref.startsWith('refs/remotes/')) return null;
  return ref;
}
function protectedBranches(context) {
  const values = new Set(['main', 'master']);
  if (typeof context.defaultBranch === 'string' && context.defaultBranch) values.add(context.defaultBranch);
  return values;
}
function isProtected(value, context) {
  const branch = normalizedBranch(value, context.currentBranch);
  return typeof branch === 'string' && protectedBranches(context).has(branch);
}
function block(ruleId, reason) {
  return {
    exitCode: 2,
    ruleId,
    message: `BLOCKED by protected-branch-guard [${ruleId}]: ${reason}. Move the work to an unprotected branch or ask the user to perform the reviewed integration action.`
  };
}
function inspectBranchMutation(args, context) {
  let mode = null;
  const operands = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.dynamic) return mode ? block('protected-git-command-uninspectable', 'a protected branch target is dynamic') : null;
    const value = token.value;
    if (value === '--') { operands.push(...args.slice(index + 1).map((entry) => entry.value)); break; }
    if (value === '-d' || value === '-D' || value === '--delete') { mode = 'delete'; continue; }
    if (value.startsWith('--delete=')) { mode = 'delete'; operands.push(value.slice('--delete='.length)); continue; }
    if (['-f', '--force'].includes(value)) { mode = 'update'; continue; }
    if (['-m', '-M', '-c', '-C', '--move', '--copy'].includes(value)) { mode = 'rename'; continue; }
    if (/^-[A-Za-z]*[dD][A-Za-z]*$/.test(value)) { mode = 'delete'; continue; }
    if (!value.startsWith('-')) operands.push(value);
  }
  if (!mode) return null;
  if (args.some((entry) => entry.dynamic)) return block('protected-git-command-uninspectable', 'a protected branch target is dynamic');
  return operands.some((value) => isProtected(value, context))
    ? block(mode === 'delete' ? 'protected-branch-delete' : 'protected-branch-update', 'the command mutates a protected local branch reference')
    : null;
}
function inspectUpdateRef(args, context) {
  const operands = []; let deleting = false;
  for (const token of args) {
    if (token.dynamic) return block('protected-git-command-uninspectable', 'an update-ref target is dynamic');
    if (token.value === '-d' || token.value === '--delete') deleting = true;
    if (!token.value.startsWith('-')) operands.push(token.value);
  }
  const target = operands[0];
  return target && (isProtected(target, context) || /^(?:refs\/)?remotes\/origin\/HEAD$/i.test(target))
    ? block(deleting ? 'protected-branch-delete' : 'protected-branch-update', 'the command mutates a protected branch or default-branch authority')
    : null;
}
function inspectBranchCreation(args, context) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.dynamic) return block('protected-git-command-uninspectable', 'a branch creation target is dynamic');
    const match = /^(?:-B|-b|-C|-c)(.*)$/.exec(token.value);
    if (!match) continue;
    const target = match[1] || args[index + 1]?.value;
    if (!target || args[index + 1]?.dynamic) return block('protected-git-command-uninspectable', 'a branch creation target is not static');
    if (isProtected(target, context)) return block('protected-branch-update', 'the command creates or resets a protected branch');
  }
  return null;
}
function inspectPush(args, context) {
  let deleting = false;
  let dryRun = false;
  let fanout = false;
  let remoteFromOption = false;
  const operands = [];
  const valueOptions = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o']);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token.dynamic) return block('protected-git-command-uninspectable', 'a push destination is dynamic');
    const value = token.value;
    if (value === '--') {
      for (const rest of args.slice(index + 1)) {
        if (rest.dynamic) return block('protected-git-command-uninspectable', 'a push destination is dynamic');
        operands.push(rest.value);
      }
      break;
    }
    if (value === '--dry-run' || value === '-n') { dryRun = true; continue; }
    if (value === '--delete' || value === '-d') { deleting = true; continue; }
    if (value.startsWith('--delete=')) { deleting = true; operands.push(value.slice('--delete='.length)); continue; }
    if (value === '--all' || value === '--mirror') { fanout = true; continue; }
    if (valueOptions.has(value)) {
      const next = args[index + 1];
      if (!next || next.dynamic) return block('protected-git-command-uninspectable', 'a push option value is not static');
      if (value === '--repo') remoteFromOption = true;
      index += 1;
      continue;
    }
    if (/^--(?:repo|receive-pack|exec|push-option)=/.test(value)) {
      if (value.startsWith('--repo=')) remoteFromOption = true;
      continue;
    }
    if (/^(?:-u|--set-upstream|--porcelain|--atomic|--follow-tags|--no-verify|--signed(?:=.+)?|--force(?:-with-lease(?:=.+)?)?|--force-if-includes|--verbose|-v|--quiet|-q|--progress|--no-progress|--ipv4|-4|--ipv6|-6)$/.test(value)) continue;
    if (value.startsWith('-')) return block('protected-git-command-uninspectable', 'a push option cannot be classified without guessing');
    operands.push(value);
  }
  if (dryRun) return null;
  if (context.inspectionError) return block('protected-branch-unverified', 'repository branch state cannot be inspected safely');
  if (fanout) return block('protected-branch-direct-push', 'a fan-out push can update a protected branch');
  const remote = remoteFromOption ? null : (operands[0] ?? null);
  const refspecs = remoteFromOption ? operands : operands.slice(1);
  if (refspecs.length === 0) {
    if (context.pushBranch && (remote === null || remote === context.pushRemote)) {
      return isProtected(context.pushBranch, context)
        ? block('protected-branch-direct-push', 'the configured push destination is a protected branch')
        : null;
    }
    const rule = context.currentBranch && protectedBranches(context).has(context.currentBranch)
      ? 'protected-branch-direct-push' : 'protected-git-command-uninspectable';
    return block(rule, 'the configured upstream push destination cannot be verified statically');
  }
  const mapped = remote === null ? (context.pushConfiguredRemotes?.size ?? 0) > 0 : Boolean(context.pushConfiguredRemotes?.has(remote));
  for (const refspec of refspecs) {
    if (/[*?[]/.test(refspec)) return block('protected-git-command-uninspectable', 'a wildcard refspec can include a protected branch');
    const separator = refspec.lastIndexOf(':');
    if (separator < 0 && mapped) {
      return block('protected-git-command-uninspectable', 'the remote has a configured push mapping that can redirect this refspec');
    }
    const destination = separator >= 0 ? refspec.slice(separator + 1) : refspec;
    if (!destination) return block('protected-git-command-uninspectable', 'a push destination is empty or ambiguous');
    if (isProtected(destination, context)) {
      return block(deleting || refspec.startsWith(':') ? 'protected-branch-delete' : 'protected-branch-direct-push', deleting || refspec.startsWith(':')
        ? 'the push deletes a protected remote branch'
        : 'the push writes directly to a protected remote branch');
    }
  }
  return null;
}
const RELEVANT_SUBCOMMANDS = new Set(['push', 'send-pack', 'http-push', 'branch', 'update-ref', 'checkout', 'switch', 'symbolic-ref', 'remote', ...HISTORY_MUTATIONS]);
const COMMAND_RUNNERS = new Set(['xargs', 'find', 'parallel', 'watch']);

// Git runs an alias only when no built-in command has that name, so a configured alias is
// expanded once and re-inspected. Shell aliases (`!…`) and aliases of aliases are not expanded.
function expandAlias(parsed, context, depth = 0) {
  const alias = context.aliases?.get(parsed.subcommand);
  if (alias === undefined) return parsed;
  if (depth > 0 || alias.trimStart().startsWith('!')) return { ambiguous: true };
  const normalized = normalizeShell(`git ${alias}`);
  if (normalized.error || normalized.invocations.length !== 1) return { ambiguous: true };
  const expanded = parseGitInvocation([...normalized.invocations[0], ...parsed.args]);
  if (!expanded || expanded.ambiguous) return { ambiguous: true };
  return expandAlias(expanded, context, depth + 1);
}

function inspectGit(parsed, context) {
  if (!parsed || !parsed.subcommand) return null;
  if (parsed.ambiguous) return block('protected-git-command-uninspectable', 'the Git invocation cannot be normalized safely');
  if (parsed.subcommand === 'send-pack' || parsed.subcommand === 'http-push') {
    return block('protected-git-command-uninspectable', 'a low-level push command can update a protected branch');
  }
  if (parsed.subcommand === 'push') return inspectPush(parsed.args, context);
  if (parsed.subcommand === 'branch') return inspectBranchMutation(parsed.args, context);
  if (parsed.subcommand === 'update-ref') return inspectUpdateRef(parsed.args, context);
  if (parsed.subcommand === 'checkout' || parsed.subcommand === 'switch') return inspectBranchCreation(parsed.args, context);
  if (parsed.subcommand === 'symbolic-ref' && parsed.args.some((token) => /^(?:refs\/)?(?:heads\/(?:main|master)|remotes\/origin\/HEAD)$/i.test(token.value))) {
    return block('protected-branch-update', 'the command mutates a protected branch or default-branch authority');
  }
  if (parsed.subcommand === 'remote' && parsed.args[0]?.value === 'set-head') {
    return block('protected-branch-update', 'the command mutates the locally discovered default-branch authority');
  }
  if (!HISTORY_MUTATIONS.has(parsed.subcommand)) return null;
  if (parsed.args.some((token) => RECOVERY_FLAGS.has(token.value))) return null;
  if (context.inspectionError) return block('protected-branch-unverified', 'repository branch state cannot be inspected safely');
  if (context.currentBranch && protectedBranches(context).has(context.currentBranch)) {
    return block('protected-branch-history-mutation', 'the Git command changes history on the current protected branch');
  }
  return null;
}
export function evaluate(input, context = {}) {
  const name = toolName(input);
  if (NATIVE_MUTATION_TOOLS.has(name)) {
    if (context.inspectionError) return block('protected-branch-unverified', 'repository branch state cannot be inspected safely');
    if (context.repo && context.currentBranch && protectedBranches(context).has(context.currentBranch)) {
      return block('protected-branch-native-mutation', 'a native file mutation would occur on the current protected branch');
    }
    return { exitCode: 0, message: '', ruleId: null };
  }
  if (name !== 'Bash') return { exitCode: 0, message: '', ruleId: null };
  const command = commandFrom(input);
  if (!command) return { exitCode: 0, message: '', ruleId: null };
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    return block('protected-command-too-large', 'the shell command exceeds the analysis limit');
  }
  const normalized = normalizeShell(command);
  if (normalized.error) return block('protected-command-uninspectable', 'the shell envelope cannot be normalized safely');
  let scopeChanged = false;
  for (const invocation of normalized.invocations) {
    const name = executable(invocation[0]);
    if (['cd', 'pushd', 'popd'].includes(name)) { scopeChanged = true; continue; }
    if (COMMAND_RUNNERS.has(name)) {
      const gitIndex = invocation.findIndex((token) => executable(token) === 'git');
      if (gitIndex >= 0) {
        const next = invocation.slice(gitIndex + 1).find((token) => !token.value.startsWith('-'));
        if (!next || next.dynamic || RELEVANT_SUBCOMMANDS.has(next.value.toLowerCase())) {
          return block('protected-command-uninspectable', 'a command runner can start a Git mutation with arguments the guard cannot see');
        }
      }
      continue;
    }
    if (invocation.some((token) => token.dynamic && /\bgit\s+(?:push|branch|update-ref|checkout|switch|symbolic-ref|remote|commit|merge|rebase|reset|cherry-pick|revert|am)\b/i.test(token.value))) {
      return block('protected-command-uninspectable', 'a command substitution can hide a protected Git mutation');
    }
    const raw = parseGitInvocation(invocation);
    if (!raw) continue;
    const parsed = raw.ambiguous ? raw : expandAlias(raw, context);
    if (parsed.ambiguous) return block('protected-git-command-uninspectable', 'the Git invocation changes or obscures repository scope');
    const relevant = RELEVANT_SUBCOMMANDS.has(parsed.subcommand);
    if (scopeChanged && relevant) return block('protected-git-scope-uninspectable', 'a shell directory change prevents reliable repository inspection');
    const decision = inspectGit(parsed, context);
    if (decision) return decision;
  }
  return { exitCode: 0, message: '', ruleId: null };
}
function cleanGitEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}
function runGit(root, args, options) {
  if (typeof options.runGit === 'function') return options.runGit(root, args);
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
    env: { ...cleanGitEnvironment(options.env ?? process.env), LC_ALL: 'C', LANG: 'C' }
  });
}
function commandResult(result) {
  if (result?.error) return { error: true };
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  if (Buffer.byteLength(stdout, 'utf8') > MAX_GIT_OUTPUT_BYTES || Buffer.byteLength(stderr, 'utf8') > MAX_GIT_OUTPUT_BYTES) return { error: true };
  return { status: result?.status, stdout: stdout.trim(), stderr: stderr.trim() };
}
export function collectContext(input, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.env ?? process.env;
  const supplied = environment.CLAUDE_PROJECT_DIR ?? input?.cwd ?? cwd;
  if (typeof supplied !== 'string' || supplied.length === 0 || /[\0\r\n]/.test(supplied) || Buffer.byteLength(supplied, 'utf8') > 16 * 1024) {
    return { repo: false, inspectionError: true };
  }
  const root = path.resolve(cwd, supplied);
  const git = (args) => commandResult(runGit(root, args, { ...options, env: environment }));
  const gitDir = git(['rev-parse', '--git-dir']);
  if (gitDir.error) return { repo: false, inspectionError: true };
  if (gitDir.status !== 0) {
    return /not a git repository|not a git work tree/i.test(gitDir.stderr)
      ? { repo: false, inspectionError: false, currentBranch: null, defaultBranch: null }
      : { repo: false, inspectionError: true };
  }
  const current = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (current.error) return { repo: true, inspectionError: true };
  let currentBranch = null;
  let detached = false;
  if (current.status === 0 && current.stdout) currentBranch = current.stdout;
  else if (current.status === 1) detached = true;
  else return { repo: true, inspectionError: true };
  const remoteHead = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead.error) return { repo: true, inspectionError: true };
  let defaultBranch = null;
  if (remoteHead.status === 0 && remoteHead.stdout.startsWith('origin/')) defaultBranch = remoteHead.stdout.slice('origin/'.length);
  else if (![1, 128].includes(remoteHead.status)) return { repo: true, inspectionError: true };

  const config = git(['config', '--get-regexp', '^(alias\\..*|remote\\..*\\.push)$']);
  if (config.error || ![0, 1].includes(config.status)) return { repo: true, inspectionError: true };
  const aliases = new Map();
  const pushConfiguredRemotes = new Set();
  for (const line of config.status === 0 ? config.stdout.split('\n') : []) {
    const separator = line.indexOf(' ');
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1);
    if (key.startsWith('alias.')) aliases.set(key.slice('alias.'.length).toLowerCase(), value);
    else if (/^remote\..+\.push$/.test(key)) pushConfiguredRemotes.add(key.slice('remote.'.length, -'.push'.length));
  }

  // `@{push}` is Git's own answer to "where would a bare `git push` write"; it honours push.default,
  // upstream, and remote.<name>.push, and fails when the answer is not a single destination.
  let pushRemote = null;
  let pushBranch = null;
  if (currentBranch) {
    const remoteName = git(['for-each-ref', '--format=%(push:remotename)', `refs/heads/${currentBranch}`]);
    const destination = git(['rev-parse', '--symbolic-full-name', '@{push}']);
    if (remoteName.error || destination.error) return { repo: true, inspectionError: true };
    const prefix = `refs/remotes/${remoteName.stdout}/`;
    if (remoteName.status === 0 && remoteName.stdout && destination.status === 0 && destination.stdout.startsWith(prefix)) {
      pushRemote = remoteName.stdout;
      pushBranch = destination.stdout.slice(prefix.length);
    }
  }

  return { repo: true, inspectionError: false, currentBranch, defaultBranch, detached, aliases, pushConfiguredRemotes, pushRemote, pushBranch };
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
  } catch {
    throw new Error('hook input is not valid JSON');
  }
}
async function main() {
  let result;
  try {
    const input = await readInput();
    result = evaluate(input, collectContext(input));
  } catch (error) {
    result = block('protected-branch-input-invalid', error.message);
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
