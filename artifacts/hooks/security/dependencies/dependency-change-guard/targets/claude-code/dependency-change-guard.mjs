#!/usr/bin/env node

import { lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function cleanGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_GIT_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_STAGED_PATHS = 4000;
export const MAX_COMMAND_BYTES = 256 * 1024;

const SHELL_EXECUTABLES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PACKAGE_EXECUTABLES = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'composer']);

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
    const match = /^\$[A-Za-z_][A-Za-z0-9_]*|^\$[0-9@*#?$!_-]/.exec(source.slice(start));
    return match ? start + match[0].length : start + 1;
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

function lexShell(source) {
  const commands = [];
  let tokens = [];
  let token = null;
  let quote = null;
  const begin = () => { if (!token) token = { value: '', dynamic: false }; };
  const pushToken = () => { if (token) tokens.push(token); token = null; };
  const pushCommand = () => { pushToken(); if (tokens.length) commands.push(tokens); tokens = []; };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") { if (character === "'") quote = null; else token.value += character; continue; }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') { if (++index >= source.length) return { error: 'trailing escape' }; token.value += source[index]; }
      else if (character === '$' || character === '`') {
        const end = expansionEnd(source, index); if (end < 0) return { error: 'unterminated expansion' };
        token.value += source.slice(index, end); token.dynamic = true; index = end - 1;
      } else token.value += character;
      continue;
    }
    if (/\s/.test(character)) { pushToken(); if (character === '\n') pushCommand(); }
    else if (character === "'" || character === '"') { begin(); quote = character; }
    else if (character === '\\') { begin(); if (++index >= source.length) return { error: 'trailing escape' }; token.value += source[index]; }
    else if (character === '$' || character === '`') {
      begin(); const end = expansionEnd(source, index); if (end < 0) return { error: 'unterminated expansion' };
      token.value += source.slice(index, end); token.dynamic = true; index = end - 1;
    } else if (';&|()'.includes(character)) { pushCommand(); if ((character === '&' || character === '|') && source[index + 1] === character) index += 1; }
    else { begin(); token.value += character; if (character === '{' || character === '}') token.dynamic = true; }
  }
  if (quote) return { error: 'unterminated quote' };
  pushCommand();
  return { commands };
}

function executableName(token) {
  return token.value.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
}

function unwrapCommand(tokens, depth) {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index].value)) {
    if (/^(?:PATH|SHELL|GIT_DIR|GIT_WORK_TREE|GIT_CONFIG[^=]*)=/.test(tokens[index].value)) return [{ ambiguous: true }];
    index += 1;
  }
  for (let count = 0; count < 16 && index < tokens.length; count += 1) {
    const executable = tokens[index];
    if (executable.dynamic || /[*?[]/.test(executable.value)) return [{ ambiguous: true }];
    const name = executableName(executable);
    if (SHELL_EXECUTABLES.has(name) || name === 'eval') {
      let payload = name === 'eval' ? index + 1 : -1;
      if (name !== 'eval') {
        for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
          if (tokens[cursor].dynamic) return [{ ambiguous: true }];
          if (tokens[cursor].value === '-c' || tokens[cursor].value === '--command' || /^-[^-]*c[^-]*$/.test(tokens[cursor].value)) { payload = cursor + 1; break; }
          if (!tokens[cursor].value.startsWith('-')) break;
        }
        if (payload < 0) return [{ tokens: tokens.slice(index) }];
      }
      if (!tokens[payload] || depth >= 3) return [{ ambiguous: true }];
      const inner = name === 'eval' ? tokens.slice(payload).map((entry) => entry.value).join(' ') : tokens[payload].value;
      const nested = normalizeShellCommands(inner, depth + 1);
      return nested.error ? [{ ambiguous: true }] : nested.commands;
    }
    if (!['exec', 'time', 'noglob', 'command', 'env', 'sudo', 'nohup'].includes(name)) return [{ tokens: tokens.slice(index) }];
    index += 1;
    if (name === 'command' && ['-v', '-V'].includes(tokens[index]?.value)) return [{ tokens: tokens.slice(index - 1) }];
    while (index < tokens.length) {
      const option = tokens[index];
      if (option.dynamic) return [{ ambiguous: true }];
      if (option.value === '--') { index += 1; break; }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(option.value)) {
        if (/^(?:PATH|SHELL|GIT_DIR|GIT_WORK_TREE|GIT_CONFIG[^=]*)=/.test(option.value)) return [{ ambiguous: true }];
        index += 1; continue;
      }
      if (!option.value.startsWith('-')) break;
      if (name === 'env') {
        if (/^(?:-S|--split-string|-C|--chdir|-a|--argv0)(?:=|$)/.test(option.value)) return [{ ambiguous: true }];
        if (/^(?:-u|--unset)$/.test(option.value)) { index += 2; continue; }
        if (/^(?:-u.+|--unset=.+|-i|--ignore-environment|-0|--null|-v|--debug)$/.test(option.value)) { index += 1; continue; }
        return [{ ambiguous: true }];
      }
      if (name === 'sudo' && /^(?:-D|--chdir|-R|--chroot)(?:=|$)/.test(option.value)) return [{ ambiguous: true }];
      const takesValue = (name === 'sudo' && /^(?:-u|-g|-h|-p|-C|-T|-r|-t)$/.test(option.value))
        || (name === 'time' && /^(?:-f|-o|--format|--output)$/.test(option.value))
        || (name === 'exec' && option.value === '-a');
      const safeNoValue = (name === 'sudo' && /^(?:-[AbEHKnS]+|--(?:askpass|background|preserve-env|edit|set-home|remove-timestamp|reset-timestamp|non-interactive|stdin|validate))$/.test(option.value))
        || (name === 'sudo' && /^--(?:user|group|host|prompt|close-from|command-timeout|role|type)=.+/.test(option.value))
        || (name === 'time' && /^(?:-a|-p|-v|--append|--portability|--verbose|--quiet|--format=.+|--output=.+)$/.test(option.value))
        || (name === 'exec' && /^(?:-c|-l)$/.test(option.value))
        || (name === 'command' && option.value === '-p');
      if (takesValue) { index += 2; continue; }
      if (safeNoValue) { index += 1; continue; }
      return [{ ambiguous: true }];
    }
  }
  if (index < tokens.length && ['exec', 'time', 'noglob', 'command', 'env', 'sudo', 'nohup'].includes(executableName(tokens[index]))) return [{ ambiguous: true }];
  return index < tokens.length ? [{ tokens: tokens.slice(index) }] : [{ ambiguous: true }];
}

export function normalizeShellCommands(command, depth = 0) {
  if (typeof command !== 'string') return { commands: [] };
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) return { error: 'command exceeds analysis limit', commands: [] };
  const lexed = lexShell(command);
  if (lexed.error) return { error: lexed.error, commands: [] };
  return { commands: lexed.commands.flatMap((tokens) => unwrapCommand(tokens, depth)) };
}

function analyzeCommitCommand(command, normalized = normalizeShellCommands(command)) {
  if (normalized.error || normalized.commands.some((entry) => entry.ambiguous)) return { ambiguous: true };
  let changedDirectory = false;
  for (const entry of normalized.commands) {
    if (!entry.tokens?.length) continue;
    const executable = executableName(entry.tokens[0]);
    if (executable === 'cd' || executable === 'pushd') { changedDirectory = true; continue; }
    if (executable !== 'git') continue;
    let index = 1;
    let unsupportedScope = changedDirectory;
    while (index < entry.tokens.length) {
      const token = entry.tokens[index];
      if (token.dynamic) return { ambiguous: true };
      if (token.value === '--') { index += 1; break; }
      if (!token.value.startsWith('-')) break;
      if (/^(?:-C|--git-dir|--work-tree)(?:=|$)/.test(token.value)) unsupportedScope = true;
      const takesValue = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'].includes(token.value);
      index += takesValue ? 2 : 1;
    }
    if (entry.tokens[index]?.dynamic) return { ambiguous: true };
    if (entry.tokens[index]?.value === 'commit') return { found: true, unsupportedScope };
  }
  return { found: false };
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
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:sudo|command)\s+)*(?:pip(?:3)?\s+install\b[^;&|\n]*(?:--trusted-host(?:\s|=)|--index-url(?:\s|=)http:)|(?:npm|yarn|pnpm)\s+config\s+set\s+(?:strict-ssl\s+false|registry\s+http:))`, 'mi')
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

function isCommitCommand(command) {
  return analyzeCommitCommand(command).found === true;
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

function collectCommitEntries(projectRoot) {
  const rawNames = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], projectRoot);
  const stagedPaths = rawNames.toString('utf8').split('\0').filter(Boolean).map(normalizeRelative);
  if (stagedPaths.length > MAX_STAGED_PATHS) throw new Error(`staged path count exceeds ${MAX_STAGED_PATHS}`);
  const staged = new Set(stagedPaths);
  const entries = [];

  for (const manifest of stagedPaths) {
    const manifestName = path.posix.basename(manifest);
    const lockNames = MANIFEST_LOCKS.get(manifestName.toLowerCase());
    if (!lockNames) continue;
    const locks = findNearestLocks(projectRoot, manifest, lockNames);
    if (locks.length === 0) continue;
    try {
      const current = readGitBlob(`:${manifest}`, projectRoot);
      const previous = readGitBlob(`HEAD:${manifest}`, projectRoot, true) || '';
      entries.push({
        manifest,
        locks,
        lockStaged: locks.some((lock) => staged.has(lock)),
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
    const absolute = path.resolve(projectRoot, rawPath);
    const candidate = normalizeRelative(path.relative(projectRoot, absolute));
    if (candidate !== '..' && !candidate.startsWith('../') && !path.isAbsolute(candidate)) relative = candidate;
  }

  const command = input?.tool_input?.command;
  let commitEntries;
  let commitError;
  const commitIntent = analyzeCommitCommand(command);
  if (commitIntent.found && !commitIntent.unsupportedScope) {
    try {
      commitEntries = collectCommitEntries(projectRoot);
    } catch (error) {
      commitError = error.message;
    }
  }
  return { relative, commitEntries, commitError };
}

export function evaluate(input, context = {}) {
  const command = input?.tool_input?.command;
  if (typeof command === 'string') {
    const normalized = normalizeShellCommands(command);
    const commitIntent = analyzeCommitCommand(command, normalized);
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
    if (context.commitError) {
      return { exitCode: 2, ruleId: 'dependency-commit-inspection-failed', message: `BLOCKED by dependency-change-guard [dependency-commit-inspection-failed]: staged dependency state could not be verified (${context.commitError}).` };
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
