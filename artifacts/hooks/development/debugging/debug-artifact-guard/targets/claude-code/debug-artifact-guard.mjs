#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function cleanGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_STAGED_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_GIT_BUFFER_BYTES = 16 * 1024 * 1024;
export const MAX_STAGED_PATHS = 4000;
export const MAX_COMMAND_BYTES = 256 * 1024;

const SHELL_EXECUTABLES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

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

function analyzeCommitCommand(command) {
  const normalized = normalizeShellCommands(command);
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

function normalizeRelative(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function git(args, cwd, encoding = 'utf8') {
  const result = spawnSync('git', args, {
    cwd,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: MAX_GIT_BUFFER_BYTES,
    env: cleanGitEnvironment()
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'unknown Git error').trim().slice(0, 300);
    throw new Error(detail);
  }
  return result.stdout;
}

export function detectCommitIntent(command) {
  return analyzeCommitCommand(command).found === true;
}

function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

function pushMatches(findings, file, content, ruleId, pattern) {
  for (const match of content.matchAll(pattern)) findings.push({ path: file, line: lineNumber(content, match.index), ruleId });
}

function isTestPath(file) {
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);
  return lower.split('/').some((segment) => ['test', 'tests', '__tests__', 'spec', 'specs'].includes(segment))
    || /(?:^|[._-])(?:test|spec)\.[a-z0-9]+$/.test(base);
}

export function scanContent(file, content) {
  const findings = [];
  const extension = path.posix.extname(file).toLowerCase();
  pushMatches(findings, file, content, 'merge-conflict-marker', /^(?:<{7}|={7}|>{7})(?:\s|$).*$/gm);

  if (['.js', '.jsx', '.ts', '.tsx', '.vue'].includes(extension)) {
    pushMatches(findings, file, content, 'debugger-statement', /^\s*debugger\s*;?\s*(?:\/\/.*)?$/gm);
    if (isTestPath(file)) {
      pushMatches(findings, file, content, 'focused-test', /\b(?:describe|it|test|suite|context|specify)\.only(?:\.each)?\s*\(/g);
    }
  } else if (extension === '.py') {
    pushMatches(findings, file, content, 'debugger-statement', /^\s*(?:breakpoint\(\)|(?:pdb|ipdb)\.set_trace\(\))\s*(?:#.*)?$/gm);
  } else if (extension === '.rb') {
    pushMatches(findings, file, content, 'debugger-statement', /^\s*(?:binding\.pry|byebug)\s*(?:#.*)?$/gm);
    if (file.toLowerCase().endsWith('_spec.rb')) {
      pushMatches(findings, file, content, 'focused-test', /^\s*(?:fit|fdescribe|fcontext)\b/gm);
      pushMatches(findings, file, content, 'focused-test', /\bfocus:\s*true\b/g);
    }
  } else if (extension === '.php') {
    pushMatches(findings, file, content, 'debugger-statement', /^\s*xdebug_break\(\)\s*;\s*(?:\/\/.*)?$/gm);
  }
  return findings;
}

function collectStaged(projectRoot) {
  const rawNames = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], projectRoot);
  const files = rawNames.split('\0').filter(Boolean).map(normalizeRelative);
  if (files.length > MAX_STAGED_PATHS) throw new Error(`staged path count exceeds ${MAX_STAGED_PATHS}`);
  const findings = [];
  for (const file of files) {
    let blob = git(['show', `:${file}`], projectRoot, null);
    if (!Buffer.isBuffer(blob)) blob = Buffer.from(blob);
    if (blob.includes(0)) continue;
    if (blob.length > MAX_STAGED_FILE_BYTES) {
      findings.push({ path: file, line: null, ruleId: 'debug-file-too-large' });
      continue;
    }
    findings.push(...scanContent(file, blob.toString('utf8')));
  }
  return findings;
}

export function collectContext(input, cwd = process.cwd()) {
  const projectRoot = path.resolve(input?.cwd || cwd);
  const intent = analyzeCommitCommand(input?.tool_input?.command);
  if (!intent.found || intent.unsupportedScope) {
    return {};
  }
  try {
    return { findings: collectStaged(projectRoot) };
  } catch (error) {
    return { scanError: error.message };
  }
}

export function evaluate(input, context = {}) {
  const intent = analyzeCommitCommand(input?.tool_input?.command);
  if (intent.ambiguous) {
    return { exitCode: 2, ruleId: 'debug-command-uninspectable', message: 'BLOCKED by debug-artifact-guard [debug-command-uninspectable]: the shell command cannot be normalized safely.' };
  }
  if (!intent.found) return { exitCode: 0, message: '' };
  if (intent.unsupportedScope) {
    return {
      exitCode: 2,
      ruleId: 'debug-commit-scope-unsupported',
      message: 'BLOCKED by debug-artifact-guard [debug-commit-scope-unsupported]: staged blobs cannot be verified when the commit command changes Git working context. Run the commit from that worktree directly.'
    };
  }
  if (context.scanError) {
    return { exitCode: 2, ruleId: 'debug-staged-inspection-failed', message: `BLOCKED by debug-artifact-guard [debug-staged-inspection-failed]: staged content could not be verified (${context.scanError}).` };
  }
  const findings = context.findings || [];
  if (findings.length === 0) return { exitCode: 0, message: '' };
  const first = findings[0];
  const location = first.line ? `${first.path}:${first.line}` : first.path;
  const remainder = findings.length > 1 ? ` ${findings.length - 1} additional finding(s) were suppressed.` : '';
  return {
    exitCode: 2,
    ruleId: first.ruleId,
    message: `BLOCKED by debug-artifact-guard [${first.ruleId}]: ${location} contains staged debugging or conflict residue.${remainder}`
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
    result = { exitCode: 2, message: `BLOCKED by debug-artifact-guard [debug-input-invalid]: ${error.message}.` };
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
