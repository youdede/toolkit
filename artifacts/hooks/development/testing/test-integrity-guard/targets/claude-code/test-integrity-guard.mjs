#!/usr/bin/env node
import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableName, isAssignment, isExplicitTestDirectory, isTestDirectoryPath, isTestSourcePath, SHELLS, WRAPPERS, WRAPPER_VALUE_OPTIONS } from './test-integrity-paths.mjs';
export { isTestSourcePath };
export const MAX_STDIN_BYTES = 1024 * 1024; export const MAX_FILE_BYTES = 512 * 1024; export const MAX_COMMAND_BYTES = 256 * 1024;
function normalizeRelative(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}
function readBoundedRegularFile(target) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error('symlink targets are not inspected');
  if (!stat.isFile()) throw new Error('target is not a regular file');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`existing test file exceeds ${MAX_FILE_BYTES} bytes`);
  const descriptor = openSync(target, 'r');
  try {
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== buffer.length) throw new Error('existing test file changed during inspection');
    return buffer.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}
function countOccurrences(content, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}
function reconstructEdit(existing, toolInput) {
  const oldString = toolInput?.old_string;
  const newString = toolInput?.new_string;
  if (typeof oldString !== 'string' || oldString.length === 0 || typeof newString !== 'string') {
    throw new Error('Edit requires non-empty old_string and string new_string');
  }
  const occurrences = countOccurrences(existing, oldString);
  if (toolInput?.replace_all === true) {
    if (occurrences === 0) throw new Error('old_string was not found');
    return existing.split(oldString).join(newString);
  }
  if (occurrences !== 1) throw new Error(`old_string matched ${occurrences} times`);
  return existing.replace(oldString, newString);
}
function maskCode(content, extension) {
  const hashComments = new Set(['.py', '.rb', '.php']).has(extension);
  const cComments = !new Set(['.py', '.rb']).has(extension);
  const pythonTriples = extension === '.py';
  let output = '';
  let state = 'normal';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    const three = content.slice(index, index + 3);
    if (char === '\n') {
      output += '\n'; escaped = false;
      if (state === 'line-comment') state = 'normal';
      continue;
    }
    if (state === 'line-comment') { output += ' '; continue; }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  '; index += 1;
        state = 'normal';
      } else output += ' ';
      continue;
    }
    if (state === 'triple-string') {
      if (three === quote) {
        output += '   '; index += 2;
        state = 'normal'; quote = null;
      } else output += ' ';
      continue;
    }
    if (state === 'string') {
      output += ' ';
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) { state = 'normal'; quote = null; }
      continue;
    }
    if (pythonTriples && (three === "'''" || three === '\"\"\"')) {
      output += '   '; index += 2;
      state = 'triple-string'; quote = three;
      continue;
    }
    if (cComments && char === '/' && next === '/') {
      output += '  '; index += 1; state = 'line-comment';
      continue;
    }
    if (cComments && char === '/' && next === '*') {
      output += '  '; index += 1; state = 'block-comment';
      continue;
    }
    if (hashComments && char === '#') {
      if (extension === '.php' && next === '[') output += char;
      else { output += ' '; state = 'line-comment'; }
      continue;
    }
    if (char === "'" || char === '"' || (char === '`' && ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(extension))) {
      output += ' '; state = 'string';
      quote = char; escaped = false;
      continue;
    }
    output += char;
  }
  return output;
}
function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}
function pushMatches(findings, content, ruleId, pattern) {
  for (const match of content.matchAll(pattern)) findings.push({ ruleId, line: lineNumber(content, match.index) });
}
export function scanTestIntegrity(file, content) {
  if (typeof content !== 'string') throw new Error('test content must be text');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`proposed test file exceeds ${MAX_FILE_BYTES} bytes`);
  if (!isTestSourcePath(file)) return [];
  const extension = path.posix.extname(file.toLowerCase());
  const masked = maskCode(content, extension);
  const findings = [];
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(extension)) {
    pushMatches(findings, masked, 'test-skip-introduced', /\b(?:describe|it|test|suite|context|specify)\s*\.\s*skip(?:\s*\.\s*each)?\s*\(/g);
    pushMatches(findings, masked, 'test-skip-introduced', /\b(?:xdescribe|xit|xtest)\s*\(/g);
    pushMatches(findings, content, 'test-skip-introduced', /\$\{[^}\n]*\b(?:describe|it|test|suite|context|specify)\s*\.\s*skip\s*\(/g);
  } else if (extension === '.py') {
    pushMatches(findings, masked, 'test-skip-introduced', /^\s*@(?:pytest\.mark\.(?:skip|skipif)|unittest\.(?:skip|skipIf|skipUnless))\b/gm);
    pushMatches(findings, masked, 'test-skip-introduced', /\bpytest\.skip\s*\(/g);
    pushMatches(findings, masked, 'test-xfail-introduced', /^\s*@(?:pytest\.mark\.xfail|unittest\.expectedFailure)\b/gm);
    pushMatches(findings, content, 'test-skip-introduced', /\bf(?:r|u)?["'][^"'\n]*\{[^}\n]*\bpytest\.skip\s*\(/g);
  } else if (extension === '.rb') {
    pushMatches(findings, masked, 'test-skip-introduced', /^\s*(?:xdescribe|xcontext|xit|skip|pending)\b(?!\s*=)/gm);
  } else if (extension === '.rs') {
    pushMatches(findings, masked, 'test-ignore-introduced', /^\s*#\s*\[\s*ignore(?:\s*=\s*[^\]]+)?\s*\]/gm);
  } else if (['.java', '.kt', '.kts'].includes(extension)) {
    pushMatches(findings, masked, 'test-ignore-introduced', /@(?:Disabled|Ignore)\b/g);
  } else if (extension === '.cs') {
    pushMatches(findings, masked, 'test-ignore-introduced', /\[\s*(?:Ignore|Explicit)(?:\s*\([^\]]*\))?\s*\]/g);
    pushMatches(findings, masked, 'test-skip-introduced', /\[\s*(?:Fact|Theory)\s*\([^\]]*\bSkip\s*=/g);
  } else if (extension === '.php') {
    pushMatches(findings, masked, 'test-skip-introduced', /\bmarkTestSkipped\s*\(/g);
  } else if (extension === '.go') {
    pushMatches(findings, masked, 'test-skip-introduced', /\b(?:t|tb|b)\.Skip(?:f|Now)?\s*\(/g);
  } else if (extension === '.swift') {
    pushMatches(findings, masked, 'test-skip-introduced', /\bXCTSkip(?:If|Unless)?\s*\(/g);
  }
  const sourceLines = content.split(/\r?\n/);
  for (const item of findings) {
    const line = sourceLines[item.line - 1]?.trim().replace(/\s+/g, ' ') || '';
    item.signature = `${item.ruleId}:${line}`;
  }
  return findings.sort((left, right) => left.line - right.line || left.ruleId.localeCompare(right.ruleId));
}
function lexShell(command) {
  const commands = [];
  let tokens = [];
  let value = '';
  let dynamic = false;
  let started = false;
  let quote = null;
  let escaped = false;
  const pushToken = () => {
    if (!started) return;
    tokens.push({ value, dynamic });
    value = '';
    dynamic = false;
    started = false;
  };
  const pushCommand = () => {
    pushToken();
    if (tokens.length) commands.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (escaped) {
      value += char;
      started = true;
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"') {
        escaped = true;
      } else {
        if (quote === '"' && (char === '$' || char === '`')) dynamic = true;
        value += char;
      }
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      pushToken();
      if (char === '\n') pushCommand();
      continue;
    }
    if (char === ';' || char === '|' || char === '&') {
      pushCommand();
      if (next === char) index += 1;
      continue;
    }
    if (char === '$' || char === '`' || char === '*' || char === '?' || char === '[' || char === '{') dynamic = true;
    value += char;
    started = true;
  }
  if (escaped || quote) return { error: 'shell quoting is incomplete', commands: [] };
  pushCommand();
  return { commands };
}
function unwrap(tokens, depth = 0) {
  if (depth > 3) return [{ ambiguous: true }];
  let index = 0;
  let wrapperCount = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (isAssignment(token.value)) {
      index += 1;
      continue;
    }
    const executable = executableName(token.value);
    if (!WRAPPERS.has(executable)) break;
    wrapperCount += 1;
    if (wrapperCount > 16 || token.dynamic) return [{ ambiguous: true }];
    index += 1;
    const optionsWithValues = WRAPPER_VALUE_OPTIONS.get(executable) || new Set();
    while (index < tokens.length) {
      const option = tokens[index];
      if (executable === 'env' && isAssignment(option.value)) {
        index += 1;
        continue;
      }
      if (option.value === '--') {
        index += 1;
        break;
      }
      if (!option.value.startsWith('-')) break;
      const optionName = option.value.split('=')[0];
      index += 1;
      if (!option.value.includes('=') && optionsWithValues.has(optionName)) index += 1;
    }
  }
  if (index >= tokens.length) return [{ ambiguous: true }];
  const remaining = tokens.slice(index);
  const executable = executableName(remaining[0].value);
  if (SHELLS.has(executable)) {
    const controlIndex = remaining.findIndex((token, tokenIndex) => tokenIndex > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(token.value));
    if (controlIndex !== -1) {
      const payload = remaining[controlIndex + 1];
      if (!payload || payload.dynamic) return [{ ambiguous: true }];
      const nested = lexShell(payload.value);
      if (nested.error) return [{ ambiguous: true }];
      return nested.commands.flatMap((commandTokens) => unwrap(commandTokens, depth + 1));
    }
  }
  return [{ tokens: remaining }];
}
function positional(tokens, start) {
  const result = [];
  let optionMode = true;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (optionMode && token.value === '--') {
      optionMode = false;
      continue;
    }
    if (optionMode && token.value.startsWith('-')) continue;
    result.push(token);
  }
  return result;
}
function mutationFinding(tokens) {
  if (!tokens?.length || tokens[0].dynamic) return null;
  let executable = executableName(tokens[0].value);
  let start = 1;
  if (executable === 'git') {
    while (start < tokens.length && tokens[start].value.startsWith('-')) {
      const option = tokens[start].value;
      start += 1;
      if (['-C', '-c', '--git-dir', '--work-tree', '--config-env'].includes(option) && !option.includes('=')) start += 1;
    }
    executable = tokens[start]?.value;
    start += 1;
  }
  if (executable === 'rm' || executable === 'unlink') {
    const targets = positional(tokens, start);
    const target = targets.find((item) => isTestSourcePath(item.value) || isExplicitTestDirectory(item.value)
      || ['.', './'].includes(item.value) || (item.dynamic && /^[*?[]/.test(item.value)));
    if (target) return { ruleId: 'test-file-delete' };
    const ambiguous = targets.find((item) => item.dynamic && isTestDirectoryPath(item.value));
    if (ambiguous) return { ruleId: 'test-command-uninspectable' };
  }
  if (executable === 'mv') {
    let targetDirectory = null;
    for (let index = start; index < tokens.length; index += 1) {
      const value = tokens[index].value;
      if (value === '-t' || value === '--target-directory') targetDirectory = tokens[index + 1];
      else if (value.startsWith('--target-directory=')) targetDirectory = { value: value.slice(value.indexOf('=') + 1), dynamic: tokens[index].dynamic };
    }
    if (targetDirectory) {
      const sources = positional(tokens.filter((_, index) => index !== tokens.indexOf(targetDirectory)), start);
      if (sources.some((source) => isTestSourcePath(source.value) || isExplicitTestDirectory(source.value))
        && !isTestDirectoryPath(targetDirectory.value)) return { ruleId: 'test-file-rename-away' };
    }
    const paths = positional(tokens, start);
    if (paths.length >= 2) {
      const destination = paths.at(-1);
      for (const source of paths.slice(0, -1)) {
        if (!isTestSourcePath(source.value) && !isExplicitTestDirectory(source.value)) continue;
        if (destination.dynamic) return { ruleId: 'test-command-uninspectable' };
        if (!isTestSourcePath(destination.value) && !isTestDirectoryPath(destination.value) && !isExplicitTestDirectory(destination.value)) return { ruleId: 'test-file-rename-away' };
      }
    }
  }
  if (executable === 'find') {
    const deleteIndex = tokens.findIndex((token, index) => index >= start && token.value === '-delete');
    if (deleteIndex !== -1) {
      const roots = tokens.slice(start, deleteIndex).filter((token) => !token.value.startsWith('-'));
      if (roots.some((token) => isTestSourcePath(token.value) || isTestDirectoryPath(token.value) || ['.', './'].includes(token.value))) return { ruleId: 'test-file-delete' };
    }
  }
  return null;
}
export function analyzeTestCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return { finding: null };
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) return { finding: { ruleId: 'test-command-too-large' } };
  const lexed = lexShell(command);
  if (lexed.error) {
    const relevant = /\b(?:rm|unlink|mv|find|git)\b/.test(command) && /(?:^|[\\/])(?:tests?|specs?|__tests__)(?:[\\/]|$)|(?:[._-])(?:test|spec)\./i.test(command);
    return { finding: relevant ? { ruleId: 'test-command-uninspectable' } : null };
  }
  for (const rawTokens of lexed.commands) {
    for (const entry of unwrap(rawTokens)) {
      if (entry.ambiguous) {
        const text = rawTokens.map((token) => token.value).join(' ');
        if (/\b(?:rm|unlink|mv|find|git)\b/.test(text) && /(?:tests?|specs?|__tests__)/i.test(text)) {
          return { finding: { ruleId: 'test-command-uninspectable' } };
        }
        continue;
      }
      const found = mutationFinding(entry.tokens);
      if (found) return { finding: found };
    }
  }
  return { finding: null };
}
function newFindings(before, after) {
  const available = new Map();
  const key = (item) => item.signature || item.ruleId;
  for (const item of before) available.set(key(item), (available.get(key(item)) || 0) + 1);
  const added = [];
  for (const item of after) {
    const count = available.get(key(item)) || 0;
    if (count > 0) available.set(key(item), count - 1);
    else added.push(item);
  }
  return added;
}
export function collectContext(input, cwd = process.cwd()) {
  const toolInput = input?.tool_input || input?.toolInput || {};
  if (typeof toolInput.command === 'string') return { relevant: true, command: toolInput.command };
  const rawPath = toolInput.file_path || toolInput.file;
  if (typeof rawPath !== 'string' || !isTestSourcePath(rawPath)) return { relevant: false };
  const projectRoot = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
  const target = path.resolve(projectRoot, rawPath);
  const relative = normalizeRelative(path.relative(projectRoot, target));
  const contained = relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
  if (!contained) return { relevant: true, relative: rawPath, errorRule: 'test-file-inspection-failed', inspectionError: 'test path leaves the active project root' };
  try {
    const canonicalRoot = realpathSync(projectRoot);
    let existing = projectRoot;
    for (const segment of path.relative(projectRoot, target).split(path.sep).filter(Boolean)) {
      const candidate = path.join(existing, segment);
      try {
        if (lstatSync(candidate).isSymbolicLink()) throw new Error('test path traverses a symbolic link');
        existing = candidate;
      } catch (error) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
    }
    const canonicalRelative = path.relative(canonicalRoot, realpathSync(existing));
    if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) throw new Error('test path resolves outside the project');
  } catch (error) {
    return { relevant: true, relative, errorRule: 'test-file-inspection-failed', inspectionError: error.message };
  }
  let existing = '';
  let exists = false;
  try {
    existing = readBoundedRegularFile(target);
    exists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { relevant: true, relative, errorRule: 'test-file-inspection-failed', inspectionError: error.message };
    }
  }
  try {
    let proposed;
    if (typeof toolInput.content === 'string') proposed = toolInput.content;
    else {
      if (!exists) throw new Error('Edit target does not exist');
      proposed = reconstructEdit(existing, toolInput);
    }
    if (Buffer.byteLength(proposed, 'utf8') > MAX_FILE_BYTES) {
      return { relevant: true, relative, errorRule: 'test-input-too-large', inspectionError: `proposed test file exceeds ${MAX_FILE_BYTES} bytes` };
    }
    return {
      relevant: true,
      relative,
      beforeFindings: scanTestIntegrity(relative, existing),
      afterFindings: scanTestIntegrity(relative, proposed)
    };
  } catch (error) {
    return { relevant: true, relative, errorRule: 'test-edit-inspection-incomplete', inspectionError: error.message };
  }
}
export function evaluate(input, context = {}) {
  const command = context.command ?? input?.tool_input?.command ?? input?.toolInput?.command;
  if (typeof command === 'string') {
    const { finding } = analyzeTestCommand(command);
    if (!finding) return { exitCode: 0, message: '', ruleId: null };
    return {
      exitCode: 2,
      ruleId: finding.ruleId,
      message: `BLOCKED by test-integrity-guard [${finding.ruleId}]: the static shell operation would delete, hide, or ambiguously relocate test coverage. The command is not echoed.`
    };
  }
  if (!context.relevant) return { exitCode: 0, message: '', ruleId: null };
  if (context.inspectionError) {
    const ruleId = context.errorRule || 'test-file-inspection-failed';
    return {
      exitCode: 2,
      ruleId,
      message: `BLOCKED by test-integrity-guard [${ruleId}]: the proposed test change could not be verified safely.`
    };
  }
  const added = newFindings(context.beforeFindings || [], context.afterFindings || []);
  if (added.length === 0) return { exitCode: 0, message: '', ruleId: null };
  const first = added[0];
  const location = context.relative ? `${context.relative}:${first.line}` : `line ${first.line}`;
  return {
    exitCode: 2,
    ruleId: first.ruleId,
    message: `BLOCKED by test-integrity-guard [${first.ruleId}]: ${location} introduces an unconditional test suppression. Remove it or have a person review the exact exception outside the guarded agent session.`
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
    result = { exitCode: 2, ruleId: 'test-input-invalid', message: `BLOCKED by test-integrity-guard [test-input-invalid]: ${error.message}.` };
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
