#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_SQL_BYTES = 512 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;

const SHELL_EXECUTABLES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const MIGRATION_EXECUTABLES = new Set(['dropdb', 'prisma', 'rails', 'rake', 'php', 'python', 'django-admin', 'typeorm', 'sequelize', 'npx', 'bunx', 'pnpm', 'yarn']);

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
        const end = expansionEnd(source, index);
        if (end < 0) return { error: 'unterminated expansion' };
        token.value += source.slice(index, end); token.dynamic = true; index = end - 1;
      } else token.value += character;
      continue;
    }
    if (/\s/.test(character)) { pushToken(); if (character === '\n') pushCommand(); }
    else if (character === "'" || character === '"') { begin(); quote = character; }
    else if (character === '\\') { begin(); if (++index >= source.length) return { error: 'trailing escape' }; token.value += source[index]; }
    else if (character === '$' || character === '`') {
      begin();
      const end = expansionEnd(source, index);
      if (end < 0) return { error: 'unterminated expansion' };
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
    if (/^(?:PATH|SHELL)=/.test(tokens[index].value)) return [{ ambiguous: true }];
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
        if (/^(?:PATH|SHELL)=/.test(option.value)) return [{ ambiguous: true }];
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
const COMMAND_START = String.raw`(?:^|[;&|()]\s*)`;

const COMMAND_RULES = [
  {
    id: 'database-drop-command',
    reason: 'a database-drop utility would delete a database',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:sudo|command)\s+)*(?:[^\s;&|()]+\/)?dropdb(?:\s|$)`, 'm')
  },
  {
    id: 'orm-database-reset',
    reason: 'an ORM command would reset or force-reset database state',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+)?(?:[^\s;&|()]+\/)?prisma\s+(?:migrate\s+reset(?:\s|$)|db\s+push\b[^;&|\n]*--(?:force-reset|accept-data-loss)(?:\s|$))`, 'm')
  },
  {
    id: 'framework-database-reset',
    reason: 'a framework command would drop, reset, purge, or flush database state',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:bundle\s+exec|bin\/)\s*)?(?:(?:rails|rake)\s+db:(?:drop|reset|purge)(?::\w+)*(?:\s|$)|php\s+artisan\s+(?:db:wipe|migrate:fresh|migrate:reset)(?:\s|$)|(?:python\s+[^;&|\n]*manage\.py|django-admin)\s+flush\b)`, 'm')
  },
  {
    id: 'schema-drop-command',
    reason: 'a schema-management command would drop the current schema',
    pattern: new RegExp(String.raw`${COMMAND_START}(?:(?:npx|bunx|pnpm\s+exec|yarn\s+dlx)\s+)?(?:typeorm\s+schema:drop|sequelize\s+db:drop)(?:\s|$)`, 'm')
  }
];

const SQL_RULES = [
  { id: 'sql-drop-database', reason: 'DROP DATABASE is a database-wide destructive statement', pattern: /\bDROP\s+DATABASE\b/i },
  { id: 'sql-drop-schema-cascade', reason: 'DROP SCHEMA CASCADE removes the schema and dependent objects', pattern: /\bDROP\s+SCHEMA\b[^;]{0,256}\bCASCADE\b/i },
  { id: 'sql-drop-table', reason: 'DROP TABLE removes a table and its data', pattern: /\bDROP\s+TABLE\b/i },
  { id: 'sql-truncate', reason: 'TRUNCATE removes table data without row qualification', pattern: /\bTRUNCATE(?:\s+TABLE)?\b/i },
  { id: 'sql-drop-column', reason: 'ALTER TABLE DROP COLUMN removes stored column data', pattern: /\bALTER\s+TABLE\b[^;]{0,512}\bDROP\s+COLUMN\b/i }
];

function normalizeRelative(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function proposedText(input, context) {
  const toolInput = input?.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return { text: '' };
  if (typeof toolInput.content === 'string') return { text: toolInput.content };
  if (typeof toolInput.new_string !== 'string') return { text: '' };
  if (typeof toolInput.old_string !== 'string') return { text: toolInput.new_string };
  if (context.inspectionError) return { error: context.inspectionError };
  if (typeof context.existingContent !== 'string') return { error: 'existing migration content is unavailable' };
  const first = context.existingContent.indexOf(toolInput.old_string);
  const second = first < 0 ? -1 : context.existingContent.indexOf(toolInput.old_string, first + Math.max(toolInput.old_string.length, 1));
  if (first < 0) return { error: 'old_string does not match the existing migration' };
  if (second >= 0 || toolInput.old_string.length === 0) return { error: 'old_string is not a unique migration edit boundary' };
  return {
    text: `${context.existingContent.slice(0, first)}${toolInput.new_string}${context.existingContent.slice(first + toolInput.old_string.length)}`
  };
}

function isMigrationSqlPath(relative) {
  if (!relative.toLowerCase().endsWith('.sql')) return false;
  return relative.toLowerCase().split('/').some((segment) => segment === 'migration' || segment === 'migrations');
}

export function maskSqlCommentsAndStrings(sql) {
  let output = '';
  let state = 'code';
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (state === 'code' && current === '-' && next === '-') {
      output += '  ';
      index += 1;
      state = 'line-comment';
    } else if (state === 'code' && current === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
    } else if (state === 'code' && current === "'") {
      output += ' ';
      state = 'string';
    } else if (state === 'line-comment' && current === '\n') {
      output += '\n';
      state = 'code';
    } else if (state === 'block-comment' && current === '*' && next === '/') {
      output += '  ';
      index += 1;
      state = 'code';
    } else if (state === 'string' && current === "'" && next === "'") {
      output += '  ';
      index += 1;
    } else if (state === 'string' && current === "'") {
      output += ' ';
      state = 'code';
    } else {
      output += state === 'code' ? current : (current === '\n' ? '\n' : ' ');
    }
  }
  return output;
}

function findSqlRule(sql) {
  const masked = maskSqlCommentsAndStrings(sql);
  for (const rule of SQL_RULES) if (rule.pattern.test(masked)) return rule;
  for (const statement of masked.split(';')) {
    if (/\bDELETE\s+FROM\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) {
      return { id: 'sql-unqualified-delete', reason: 'DELETE FROM has no visible WHERE clause in the same static statement' };
    }
  }
  return null;
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
  if (!relative || !isMigrationSqlPath(relative) || typeof input?.tool_input?.old_string !== 'string') {
    return { relative };
  }
  const absolute = path.join(projectRoot, ...relative.split('/'));
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('migration edit target must be a regular file');
    if (stat.size > MAX_SQL_BYTES) throw new Error(`existing migration exceeds ${MAX_SQL_BYTES} bytes`);
    return { relative, existingContent: readFileSync(absolute, 'utf8') };
  } catch (error) {
    return { relative, inspectionError: error.message };
  }
}

export function evaluate(input, context = {}) {
  const command = input?.tool_input?.command;
  if (typeof command === 'string') {
    const normalized = normalizeShellCommands(command);
    if (normalized.error || normalized.commands.some((entry) => entry.ambiguous)) {
      return { exitCode: 2, ruleId: 'migration-command-uninspectable', message: 'BLOCKED by migration-safety-guard [migration-command-uninspectable]: the shell command cannot be normalized safely.' };
    }
    const protectedDynamic = normalized.commands.some((entry) => entry.tokens?.length
      && MIGRATION_EXECUTABLES.has(executableName(entry.tokens[0]))
      && entry.tokens.slice(1).some((token) => token.dynamic));
    const rule = normalized.commands
      .map((entry) => entry.tokens?.map((token) => token.value).join(' ') || '')
      .flatMap((candidate) => COMMAND_RULES.filter((ruleCandidate) => ruleCandidate.pattern.test(candidate)))
      .at(0);
    if (!rule && protectedDynamic) {
      return { exitCode: 2, ruleId: 'migration-command-uninspectable', message: 'BLOCKED by migration-safety-guard [migration-command-uninspectable]: a migration command uses dynamic control arguments.' };
    }
    if (!rule) return { exitCode: 0, message: '' };
    return {
      exitCode: 2,
      ruleId: rule.id,
      message: `BLOCKED by migration-safety-guard [${rule.id}]: ${rule.reason}. Ask the user to perform any intentional destructive operation outside the guarded agent session.`
    };
  }

  if (!context.relative) return { exitCode: 0, message: '' };
  if (!isMigrationSqlPath(context.relative)) return { exitCode: 0, message: '' };
  const proposed = proposedText(input, context);
  if (proposed.error) {
    return {
      exitCode: 2,
      ruleId: 'migration-edit-inspection-incomplete',
      message: `BLOCKED by migration-safety-guard [migration-edit-inspection-incomplete]: the final migration cannot be reconstructed safely (${proposed.error}).`
    };
  }
  if (!proposed.text || proposed.text.length > MAX_SQL_BYTES) {
    if (proposed.text.length > MAX_SQL_BYTES) {
      return { exitCode: 2, ruleId: 'migration-input-too-large', message: `BLOCKED by migration-safety-guard [migration-input-too-large]: proposed migration text exceeds ${MAX_SQL_BYTES} bytes.` };
    }
    return { exitCode: 0, message: '' };
  }
  const rule = findSqlRule(proposed.text);
  if (!rule) return { exitCode: 0, message: '' };
  return {
    exitCode: 2,
    ruleId: rule.id,
    message: `BLOCKED by migration-safety-guard [${rule.id}]: ${rule.reason}. Ask the user to perform any intentional destructive operation outside the guarded agent session.`
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
    result = { exitCode: 2, message: `BLOCKED by migration-safety-guard [migration-input-invalid]: ${error.message}.` };
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
