#!/usr/bin/env node

import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;
export const MAX_PATH_BYTES = 4096;
export const MAX_PATHS = 32;
export const MAX_PATH_COMPONENTS = 64;

const DIRECT_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit', 'grep']);
const DIRECT_TARGET_REQUIRED = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell']);
const WRAPPERS = new Set(['command', 'exec', 'env', 'nohup', 'nice', 'sudo', 'time']);
const SIMPLE_FILE_COMMANDS = new Set([
  '.', 'base64', 'cat', 'chmod', 'chown', 'code', 'copy-item', 'cp', 'cut', 'get-content',
  'curl', 'dd', 'gc', 'head', 'install', 'less', 'ln', 'more', 'move-item', 'mv', 'nano', 'nl', 'od',
  'out-file', 'remove-item', 'rm', 'set-content', 'sort', 'source', 'strings',
  'tac', 'tail', 'tar', 'tee', 'uniq', 'vim', 'vi', 'wc', 'xxd', 'zip'
]);
const SEARCH_COMMANDS = new Set(['grep', 'rg']);
const SCRIPT_COMMANDS = new Set(['awk', 'sed']);
const OPTION_PATHS = new Map([
  ['grep', new Set(['-f', '--file'])],
  ['rg', new Set(['-f', '--file', '--ignore-file', '--type-add'])],
  ['sed', new Set(['-f', '--file'])],
  ['awk', new Set(['-f', '--file'])],
  ['openssl', new Set(['-in', '-out', '-key', '-cert', '-config'])],
  ['curl', new Set(['-K', '--config', '--netrc-file', '--key', '--cert', '-H', '--header', '-T', '--upload-file'])],
  ['dd', new Set(['if', 'of'])]
]);

export const MAX_RECURSIVE_ENTRIES = 20000;
// Options whose value is the next token; without this the value would be read as a path operand.
const VALUE_OPTIONS = new Map([
  ['grep', new Set(['--exclude', '--exclude-dir', '--include', '-d', '--directories', '-m', '--max-count', '-A', '-B', '-C', '--context'])],
  ['rg', new Set(['-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '-j', '--threads'])]
]);

export function globToRegExp(glob) {
  let source = '';
  let braces = 0;
  for (const character of glob) {
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '{') { braces += 1; source += '(?:'; }
    else if (character === '}' && braces > 0) { braces -= 1; source += ')'; }
    else if (character === ',' && braces > 0) source += '|';
    else source += character.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return braces === 0 ? new RegExp(`^${source}$`) : null;
}

// A glob that cannot be translated is dropped, so nothing is excluded by it: the walk then sees
// more files, never fewer.
function compileGlobs(values) {
  return values.map((value) => globToRegExp(value.split('/').at(-1))).filter(Boolean);
}

function optionValues(tokens, names) {
  const values = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    const equals = value.indexOf('=');
    const name = equals < 0 ? value : value.slice(0, equals);
    if (!names.has(name)) continue;
    if (equals >= 0) values.push(value.slice(equals + 1));
    else if (tokens[index + 1]) values.push(tokens[index + 1].value);
  }
  return values;
}

function recursiveReadMode(executable, tokens) {
  const values = tokens.slice(1).map((token) => token.value);
  if (executable === 'grep') {
    const recursive = values.some((value) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(value)
      || ['--recursive', '--dereference-recursive', '--directories=recurse'].includes(value))
      || values.some((value, index) => value === '-d' && values[index + 1] === 'recurse');
    if (!recursive) return null;
    return {
      hidden: true,
      excludes: compileGlobs(optionValues(tokens, new Set(['--exclude']))),
      excludeDirs: compileGlobs(optionValues(tokens, new Set(['--exclude-dir']))),
      includes: compileGlobs(optionValues(tokens, new Set(['--include'])))
    };
  }
  if (executable === 'rg') {
    const globs = optionValues(tokens, new Set(['-g', '--glob']));
    return {
      hidden: values.some((value) => value === '--hidden' || value === '-.' || /^-u{2,}$/.test(value)),
      excludes: compileGlobs(globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1))),
      excludeDirs: [],
      includes: compileGlobs(globs.filter((glob) => !glob.startsWith('!')))
    };
  }
  if (executable === 'tar') {
    return { hidden: true, excludes: compileGlobs(optionValues(tokens, new Set(['--exclude']))), excludeDirs: [], includes: [] };
  }
  if (executable === 'cp') {
    const recursive = values.some((value) => /^-[A-Za-z]*[rRa][A-Za-z]*$/.test(value) || ['--recursive', '--archive'].includes(value));
    return recursive ? { hidden: true, excludes: [], excludeDirs: [], includes: [] } : null;
  }
  if (executable === 'zip') {
    const recursive = values.some((value) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(value) || value === '--recurse-paths');
    return recursive ? { hidden: true, excludes: [], excludeDirs: [], includes: [] } : null;
  }
  return null;
}

export function directoryHoldsSensitive(root, options) {
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return { error: true }; }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_RECURSIVE_ENTRIES) return { error: true };
      if (!options.hidden && entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // ponytail: .git is skipped for speed; its config can hold a credential URL, which this
        // guard never listed as a protected path. Add it here if that list grows.
        if (entry.name === '.git' || options.excludeDirs.some((pattern) => pattern.test(entry.name))) continue;
        if (isSensitivePath(absolute)) return { sensitive: true };
        pending.push(absolute);
        continue;
      }
      if (options.excludes.some((pattern) => pattern.test(entry.name))) continue;
      if (options.includes.length && !options.includes.some((pattern) => pattern.test(entry.name))) continue;
      if (isSensitivePath(absolute)) return { sensitive: true };
    }
  }
  return { sensitive: false };
}

const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];
const SENSITIVE_DIRECTORY_SUFFIXES = ['/.aws', '/.azure', '/.config/gcloud', '/.kube', '/.ssh'];
const SAFE_SSH_FILES = new Set(['authorized_keys', 'config', 'known_hosts']);
const EXACT_CREDENTIAL_SUFFIXES = [
  '/.aws/credentials',
  '/.azure/accessTokens.json',
  '/.config/gcloud/application_default_credentials.json',
  '/.config/gh/hosts.yml',
  '/.docker/config.json',
  '/.git-credentials',
  '/.kube/config',
  '/.netrc',
  '/.npmrc',
  '/.pypirc'
].map((entry) => entry.toLowerCase());
const SSH_PRIVATE_KEY = /\/(?:\.ssh\/)?id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i;

function allowed() {
  return { exitCode: 0, ruleId: null, message: '' };
}

function blocked(ruleId, reason) {
  return {
    exitCode: 2,
    ruleId,
    message: `BLOCKED by sensitive-file-access-guard [${ruleId}]: ${reason}. The submitted path and content were not printed.`
  };
}

function inputToolName(input) {
  return String(input?.tool_name ?? input?.toolName ?? '').split('__').at(-1).toLowerCase();
}

function toolInput(input) {
  return input?.tool_input ?? input?.toolInput ?? input ?? {};
}

function expansionEnd(source, start) {
  if (source[start] === '`') {
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === '\\') cursor += 1;
      else if (source[cursor] === '`') return cursor + 1;
    }
    return -1;
  }
  if (source[start + 1] !== '(' && source[start + 1] !== '{') {
    const variable = /^\$[A-Za-z_][A-Za-z0-9_]*|^\$[0-9@*#?$!_-]/.exec(source.slice(start));
    return variable ? start + variable[0].length : start + 1;
  }
  const open = source[start + 1];
  const close = open === '(' ? ')' : '}';
  let depth = 1;
  let quote = null;
  for (let cursor = start + 2; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '\\') { cursor += 1; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === open) depth += 1;
    else if (character === close && --depth === 0) return cursor + 1;
  }
  return -1;
}

function shellSegments(source) {
  const segments = [];
  let tokens = [];
  let token = null;
  let quote = null;
  const begin = () => { token ??= { value: '', dynamic: false }; };
  const pushToken = () => { if (token) tokens.push(token); token = null; };
  const pushSegment = () => { pushToken(); if (tokens.length) segments.push(tokens); tokens = []; };

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote === "'") {
      if (character === "'") quote = null;
      else token.value += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') {
        if (++cursor >= source.length) return { error: true, segments: [] };
        token.value += source[cursor];
      } else if (character === '$' || character === '`') {
        const end = expansionEnd(source, cursor);
        if (end < 0) return { error: true, segments: [] };
        token.value += source.slice(cursor, end);
        token.dynamic = true;
        cursor = end - 1;
      } else token.value += character;
      continue;
    }
    if (/\s/.test(character)) {
      pushToken();
      if (character === '\n') pushSegment();
    } else if (character === "'" || character === '"') {
      begin();
      quote = character;
    } else if (character === '\\') {
      begin();
      if (++cursor >= source.length) return { error: true, segments: [] };
      token.value += source[cursor];
    } else if (character === '$' || character === '`') {
      begin();
      const end = expansionEnd(source, cursor);
      if (end < 0) return { error: true, segments: [] };
      token.value += source.slice(cursor, end);
      token.dynamic = true;
      cursor = end - 1;
    } else if (';&|()'.includes(character)) {
      pushSegment();
      if ((character === '&' || character === '|') && source[cursor + 1] === character) cursor += 1;
    } else if (character === '<' || character === '>') {
      pushToken();
      let operator = character;
      if (source[cursor + 1] === character || source[cursor + 1] === '&') operator += source[++cursor];
      tokens.push({ value: operator, dynamic: false, redirection: true });
    } else {
      begin();
      token.value += character;
      if ('*?['.includes(character)) token.dynamic = true;
    }
  }
  if (quote) return { error: true, segments: [] };
  pushSegment();
  return { error: false, segments };
}

function executableName(token) {
  return token.value.replaceAll('\\', '/').split('/').at(-1).replace(/\.exe$/i, '').toLowerCase();
}

function skipWrapperOptions(tokens, index, wrapper) {
  while (index < tokens.length) {
    const value = tokens[index].value;
    if (tokens[index].dynamic) return -1;
    if (value === '--') return index + 1;
    if (wrapper === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) { index += 1; continue; }
    if (!value.startsWith('-')) return index;
    const consumes = (wrapper === 'sudo' && ['-u', '-g', '-h', '-p', '-C', '-T'].includes(value))
      || (wrapper === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(value))
      || (wrapper === 'nice' && ['-n', '--adjustment'].includes(value))
      || (wrapper === 'time' && ['-f', '-o', '--format', '--output'].includes(value));
    index += consumes ? 2 : 1;
  }
  return index;
}

function normalizedCommands(tokens, depth = 0) {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index].value)) {
    if (tokens[index].dynamic) return [{ ambiguous: true }];
    index += 1;
  }
  for (let layers = 0; layers < 12 && index < tokens.length; layers += 1) {
    if (tokens[index].dynamic) return [{ ambiguous: true }];
    const executable = executableName(tokens[index]);
    if (SHELLS.has(executable) || executable === 'eval') {
      let payload = executable === 'eval' ? index + 1 : -1;
      if (executable !== 'eval') {
        for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
          if (tokens[cursor].dynamic) return [{ ambiguous: true }];
          const control = tokens[cursor].value.toLowerCase();
          if (control === '-c' || control === '--command' || /^-[^-]*c[^-]*$/.test(control)) {
            payload = cursor + 1;
            break;
          }
          if (!tokens[cursor].value.startsWith('-')) break;
        }
      }
      if (payload < 0) return [{ tokens: tokens.slice(index) }];
      if (!tokens[payload] || tokens[payload].dynamic || depth >= 3) return [{ ambiguous: true }];
      const source = executable === 'eval' ? tokens.slice(payload).map((token) => token.value).join(' ') : tokens[payload].value;
      const nested = shellSegments(source);
      if (nested.error) return [{ ambiguous: true }];
      return nested.segments.flatMap((segment) => normalizedCommands(segment, depth + 1));
    }
    if (!WRAPPERS.has(executable)) return [{ tokens: tokens.slice(index) }];
    index = skipWrapperOptions(tokens, index + 1, executable);
    if (index < 0) return [{ ambiguous: true }];
  }
  return index < tokens.length ? [{ ambiguous: true }] : [];
}

function pathOperands(tokens) {
  const candidates = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].redirection && !tokens[index + 1].redirection) candidates.push(tokens[index + 1]);
  }
  if (!tokens.length || tokens[0].dynamic) return { candidates, ambiguous: Boolean(tokens[0]?.dynamic) };
  const executable = executableName(tokens[0]);
  if (!SIMPLE_FILE_COMMANDS.has(executable) && !SEARCH_COMMANDS.has(executable)
    && !SCRIPT_COMMANDS.has(executable) && !OPTION_PATHS.has(executable)) {
    return { candidates, ambiguous: false };
  }

  const positionals = [];
  let explicitPattern = false;
  const optionPaths = OPTION_PATHS.get(executable) ?? new Set();
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.redirection) { index += 1; continue; }
    const exactOption = token.value.split('=')[0];
    if (optionPaths.has(exactOption)) {
      explicitPattern = true;
      const attached = token.value.includes('=') ? token.value.slice(token.value.indexOf('=') + 1) : null;
      if (attached !== null) candidates.push({ value: attached, dynamic: token.dynamic });
      else if (tokens[index + 1]) candidates.push(tokens[++index]);
      continue;
    }
    if (['-e', '--regexp', '--expression'].includes(exactOption)) {
      explicitPattern = true;
      if (!token.value.includes('=')) index += 1;
      continue;
    }
    if (VALUE_OPTIONS.get(executable)?.has(token.value)) { index += 1; continue; }
    if (token.value === '--') {
      positionals.push(...tokens.slice(index + 1).filter((entry) => !entry.redirection));
      break;
    }
    if (token.value.startsWith('-') && !token.dynamic) continue;
    positionals.push(token);
  }

  let operands = [];
  if (SEARCH_COMMANDS.has(executable) || SCRIPT_COMMANDS.has(executable)) operands = positionals.slice(explicitPattern ? 0 : 1);
  else if (SIMPLE_FILE_COMMANDS.has(executable)) operands = positionals;
  const recursive = recursiveReadMode(executable, tokens);
  if (recursive && operands.length === 0 && SEARCH_COMMANDS.has(executable)) operands = [{ value: '.', dynamic: false }];
  candidates.push(...(recursive ? operands.map((token) => ({ ...token, recursive })) : operands));
  return { candidates, ambiguous: false };
}

function directCandidates(data) {
  const values = [];
  for (const key of ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path']) {
    if (data?.[key] === undefined) continue;
    if (typeof data[key] !== 'string' || data[key].length === 0) return { invalid: true, values: [] };
    values.push({ value: data[key], dynamic: false });
  }
  if (data?.paths !== undefined) {
    if (!Array.isArray(data.paths) || data.paths.some((value) => typeof value !== 'string' || value.length === 0)) {
      return { invalid: true, values: [] };
    }
    for (const value of data.paths) values.push({ value, dynamic: false });
  }
  return { invalid: false, values };
}

export function collectCandidates(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { invalid: true, relevant: true, candidates: [] };
  const name = inputToolName(input);
  const data = toolInput(input);
  const hasCommand = typeof data?.command === 'string' || typeof input.command === 'string';
  if (DIRECT_TOOLS.has(name)) {
    const direct = directCandidates(data);
    const missing = DIRECT_TARGET_REQUIRED.has(name) && direct.values.length === 0;
    let candidates = direct.values;
    if (name === 'grep') {
      const grepTargets = direct.values.length ? direct.values : [{ value: '.', dynamic: false }];
      const include = typeof data?.glob === 'string' ? compileGlobs([data.glob]) : [];
      candidates = grepTargets.map((candidate) => ({ ...candidate, recursive: { hidden: true, excludes: [], excludeDirs: [], includes: include } }));
    }
    return {
      invalid: direct.invalid || missing,
      relevant: true,
      candidates: candidates.slice(0, MAX_PATHS),
      tooMany: candidates.length > MAX_PATHS
    };
  }
  if (!SHELL_TOOLS.has(name) && !hasCommand) return { invalid: false, relevant: false, candidates: [] };
  const command = data?.command ?? input.command;
  if (typeof command !== 'string') {
    return SHELL_TOOLS.has(name)
      ? { invalid: true, relevant: true, candidates: [] }
      : { invalid: false, relevant: false, candidates: [] };
  }
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) return { invalid: true, relevant: true, candidates: [] };
  const parsed = shellSegments(command);
  if (parsed.error) return { invalid: true, relevant: true, candidates: [] };
  const entries = parsed.segments.flatMap((segment) => normalizedCommands(segment));
  const candidates = parsed.segments.flatMap((segment) => pathOperands(segment).candidates);
  let ambiguous = false;
  for (const entry of entries) {
    if (entry.ambiguous) { ambiguous = true; continue; }
    const extracted = pathOperands(entry.tokens);
    candidates.push(...extracted.candidates);
    ambiguous ||= extracted.ambiguous;
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.dynamic ? '1' : '0'}:${candidate.recursive ? 'r' : ''}:${candidate.value}`;
    if (!seen.has(key)) { seen.add(key); unique.push(candidate); }
  }
  return { invalid: false, relevant: true, candidates: unique.slice(0, MAX_PATHS), tooMany: unique.length > MAX_PATHS, ambiguous };
}

function normalizedPortablePath(value) {
  const slashed = String(value).replaceAll('\\', '/').replace(/^file:\/\//i, '');
  const prefix = slashed.startsWith('/') ? '/' : '';
  const parts = [];
  for (const part of slashed.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${prefix}${parts.join('/')}`;
}

export function isSensitivePath(value) {
  let candidate = String(value);
  const embedded = /^(?:@|<)(.+)$|^[^=@\s]+(?:=|@)[@<]?(.+)$/.exec(candidate);
  if (embedded) candidate = embedded[1] || embedded[2];
  const normalized = normalizedPortablePath(candidate).toLowerCase();
  const basename = normalized.split('/').at(-1);
  if (basename.startsWith('.env') && SAFE_ENV_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return false;
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (SSH_PRIVATE_KEY.test(normalized)) return true;
  if (normalized.includes('/.ssh/') && !basename.endsWith('.pub') && !SAFE_SSH_FILES.has(basename)) return true;
  if (SENSITIVE_DIRECTORY_SUFFIXES.some((suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix))) return true;
  return EXACT_CREDENTIAL_SUFFIXES.some((suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix));
}

function absoluteCandidate(value, cwd) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.resolve(os.homedir(), value.slice(2));
  return path.resolve(cwd, value);
}

function inspectPath(value, cwd) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) return { error: true };
  if (!value || value === '-' || /^https?:\/\//i.test(value)) return { skipped: true };
  const absolute = absoluteCandidate(value, cwd);
  const root = path.parse(absolute).root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  if (parts.length > MAX_PATH_COMPONENTS) return { error: true };
  let current = root;
  let hasSymlink = false;
  let exists = true;
  let existing = root;
  let missing = [];
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      current = path.join(current, part);
      try {
        const metadata = lstatSync(current);
        if (metadata.isSymbolicLink()) hasSymlink = true;
        existing = current;
      } catch (error) {
        if (error?.code === 'ENOENT') { exists = false; missing = parts.slice(index); break; }
        return { error: true };
      }
    }
    const resolvedBase = realpathSync(existing);
    return {
      exists,
      hasSymlink,
      resolvedPath: exists ? realpathSync(absolute) : path.join(resolvedBase, ...missing)
    };
  } catch {
    return { error: true };
  }
}

export function collectRuntimeContext(input) {
  const analysis = collectCandidates(input);
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  return {
    pathFacts: analysis.candidates.map((candidate) => {
      if (candidate.dynamic) return null;
      const fact = inspectPath(candidate.value, cwd);
      if (!candidate.recursive || fact.error || !fact.exists) return fact;
      let metadata;
      try { metadata = statSync(fact.resolvedPath); } catch { return { error: true }; }
      if (!metadata.isDirectory()) return fact;
      return { ...fact, recursive: directoryHoldsSensitive(fact.resolvedPath, candidate.recursive) };
    })
  };
}

export function evaluate(input, context = {}) {
  const analysis = collectCandidates(input);
  if (analysis.invalid) return blocked('sensitive-input-invalid', 'structured input or command syntax is invalid or exceeds a fixed analysis limit');
  if (!analysis.relevant) return allowed();
  if (analysis.tooMany) return blocked('sensitive-path-uninspectable', 'the operation addresses more paths than the bounded analyzer can verify');
  if (analysis.ambiguous) return blocked('sensitive-path-uninspectable', 'the file-access command uses a dynamic executable or nested command envelope');
  const facts = Array.isArray(context.pathFacts) ? context.pathFacts : [];
  for (let index = 0; index < analysis.candidates.length; index += 1) {
    const candidate = analysis.candidates[index];
    if (candidate.dynamic) return blocked('sensitive-path-uninspectable', 'a protected file-access boundary uses a dynamic path');
    if (typeof candidate.value !== 'string' || candidate.value.includes('\0')
      || Buffer.byteLength(candidate.value, 'utf8') > MAX_PATH_BYTES) {
      return blocked('sensitive-path-uninspectable', 'a protected path is invalid or exceeds a fixed analysis limit');
    }
    if (isSensitivePath(candidate.value)) return blocked('sensitive-path-access', 'the operation targets a high-confidence credential or secret file');
    const fact = facts[index];
    if (fact?.error) return blocked('sensitive-path-uninspectable', 'filesystem alias metadata cannot be inspected safely');
    if (fact?.resolvedPath && isSensitivePath(fact.resolvedPath)) {
      return blocked('sensitive-path-alias', 'a filesystem alias resolves to a high-confidence credential or secret file');
    }
    if (fact?.recursive?.error) return blocked('sensitive-path-uninspectable', 'a recursive file operation covers more entries than the bounded analyzer can verify');
    if (fact?.recursive?.sensitive) {
      return blocked('sensitive-path-recursive', 'a recursive file operation would include a high-confidence credential or secret file; exclude it or narrow the path');
    }
  }
  return allowed();
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error('input limit exceeded');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new Error('input is not valid JSON'); }
}

async function main() {
  let result;
  try {
    const input = await readInput();
    result = evaluate(input, collectRuntimeContext(input));
  } catch {
    result = blocked('sensitive-input-invalid', 'structured hook input is invalid or exceeds a fixed limit');
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
