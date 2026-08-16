#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_SQL_BYTES = 256 * 1024;
const DATABASE_MCP = /^mcp__(?:[a-z0-9]+_)*(?:postgres|postgresql|mysql|mariadb|sqlite|database|db|neon|supabase)(?:_[a-z0-9]+)*__(?:query|execute_query|run_query|sql|execute_sql|run_sql)$/i;
const SHELL_TOOLS = /^(?:Bash|PowerShell)$/;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by database-query-mode-guard [' + ruleId + ']: ' + detail + '.' }; }

export function collectContext() { return {}; }

function maskSql(text) {
  return text
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''")
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/#[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|\\.|[^'])*'/g, "''")
    .replace(/"(?:""|\\.|[^"])*"/g, 'identifier')
    .replace(/`(?:``|[^`])*`/g, 'identifier')
    .replace(/\[(?:\]\]|[^\]])*\]/g, 'identifier');
}
function shellWords(command) {
  const words = []; let word = ''; let quote = ''; let escaped = false;
  for (const character of command) {
    if (escaped) { word += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ''; else word += character; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/.test(character)) { if (word) { words.push(word); word = ''; } continue; }
    if (/[;&|<>]/.test(character)) { if (word) { words.push(word); word = ''; } words.push(character); continue; }
    word += character;
  }
  if (word) words.push(word);
  return { words, balanced: !quote && !escaped };
}
function flagValue(words, flags) {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]; const lowerWord = word.toLowerCase();
    for (const flag of flags) {
      const lowerFlag = flag.toLowerCase();
      if (lowerWord === lowerFlag && typeof words[index + 1] === 'string' && !/^[;&|<>]$/.test(words[index + 1])) return words[index + 1];
      if (lowerWord.startsWith(lowerFlag + '=') || (flag.length === 2 && lowerWord.startsWith(lowerFlag) && word.length > 2)) return word.slice(flag.length + (word[flag.length] === '=' ? 1 : 0));
    }
  }
  return '';
}
function shellSql(command) {
  const parsed = shellWords(command); const words = parsed.words;
  const clientIndex = words.findIndex((word) => /^(?:psql|mysql|mariadb|sqlcmd|sqlite3|Invoke-Sqlcmd)$/i.test(word.split('/').at(-1)));
  if (clientIndex < 0) return { relevant: false };
  if (!parsed.balanced || words.some((word) => /^(?:[|<>]|<<?|>>?)$/.test(word))) return { relevant: true, uninspectable: true };
  const client = words[clientIndex].split('/').at(-1).toLowerCase(); const tail = words.slice(clientIndex + 1);
  let sql = '';
  if (client === 'psql') sql = flagValue(tail, ['-c', '--command']);
  else if (client === 'mysql' || client === 'mariadb') sql = flagValue(tail, ['-e', '--execute']);
  else if (client === 'sqlcmd') sql = flagValue(tail, ['-Q', '-q']);
  else if (client === 'invoke-sqlcmd') sql = flagValue(tail, ['-Query']);
  else {
    const candidates = tail.filter((word) => !word.startsWith('-') && !/^[;&|<>]$/.test(word));
    sql = candidates.length >= 2 ? candidates.at(-1) : '';
  }
  return sql ? { relevant: true, sql } : { relevant: true, uninspectable: true };
}
function extractSql(input) {
  if (DATABASE_MCP.test(input.tool_name)) {
    const tool = input.tool_input;
    if (!tool || typeof tool !== 'object') return { relevant: true, uninspectable: true };
    for (const key of ['query', 'sql', 'statement', 'query_text', 'text']) if (typeof tool[key] === 'string' && tool[key].trim()) return { relevant: true, sql: tool[key] };
    return { relevant: true, uninspectable: true };
  }
  if (SHELL_TOOLS.test(input.tool_name)) return typeof input.tool_input?.command === 'string' && input.tool_input.command.trim()
    ? shellSql(input.tool_input.command) : { relevant: false };
  return { relevant: false };
}
function readOrControl(sql) {
  const statements = sql.split(';').map((part) => part.trim()).filter(Boolean);
  return statements.length > 0 && statements.every((statement) => /^(?:SELECT\b|SHOW\b|DESCRIBE\b|DESC\b|EXPLAIN\b|WITH\b|BEGIN\b|START\s+TRANSACTION\b|COMMIT\b|ROLLBACK\b|SET\s+TRANSACTION\b)/i.test(statement));
}
export function evaluate(input) {
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_name) return block('database-query-mode-input-invalid', 'the hook envelope is incomplete');
  const extracted = extractSql(input);
  if (!extracted.relevant) return allow();
  if (extracted.uninspectable) return block('database-query-uninspectable', 'a database client invocation does not expose bounded inline SQL');
  if (Buffer.byteLength(extracted.sql) > MAX_SQL_BYTES) return block('database-query-too-large', 'the submitted SQL exceeds the bounded inspection limit');
  const normalized = maskSql(extracted.sql).replace(/\s+/g, ' ').trim();
  if (/\b(?:INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|CALL|EXECUTE|VACUUM|COPY)\b/i.test(normalized)) return block('live-database-write', 'a mutating SQL statement was submitted directly to a live query tool');
  if (!readOrControl(normalized)) return block('database-query-mode-unknown', 'the SQL statement is not provably read-oriented');
  return allow();
}

async function receiveEnvelope() {
  const chunks = []; let received = 0;
  for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); }
  try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; }
  catch { throw new Error('hook input is not valid JSON'); }
}
async function runHook() {
  let result;
  try { const input = await receiveEnvelope(); result = evaluate(input); }
  catch (error) { result = block('database-query-mode-input-invalid', error.message); }
  if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
