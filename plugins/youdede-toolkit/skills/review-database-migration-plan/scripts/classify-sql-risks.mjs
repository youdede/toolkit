#!/usr/bin/env node

import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 256 * 1024;
const MAX_FINDINGS = 100;
const DDL_RULES = [
  ['MIG_SQL_DROP_TABLE', /\bdrop\s+table\b/gi],
  ['MIG_SQL_DROP_COLUMN', /\bdrop\s+column\b/gi],
  ['MIG_SQL_TRUNCATE', /\btruncate(?:\s+table)?\b/gi]
];

function lineNumber(text, index) { return text.slice(0, index).split('\n').length; }

function maskSqlLiteralsAndComments(sql) {
  const output = [...sql];
  const blank = (index) => { if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' '; };
  for (let index = 0; index < sql.length;) {
    if (sql.startsWith('--', index)) {
      while (index < sql.length && sql[index] !== '\n') blank(index++);
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 0;
      while (index < sql.length) {
        if (sql.startsWith('/*', index)) { blank(index++); blank(index++); depth += 1; continue; }
        if (sql.startsWith('*/', index)) {
          blank(index++); blank(index++); depth -= 1;
          if (depth === 0) break;
          continue;
        }
        blank(index++);
      }
      continue;
    }
    if (sql[index] === "'" || sql[index] === '"' || sql[index] === '`') {
      const quote = sql[index];
      blank(index++);
      while (index < sql.length) {
        blank(index);
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { blank(index + 1); index += 2; continue; }
          index += 1;
          break;
        }
        if (sql[index] === '\\' && index + 1 < sql.length) { blank(index + 1); index += 2; continue; }
        index += 1;
      }
      continue;
    }
    if (sql[index] === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))?.[0];
      if (tag) {
        for (let offset = 0; offset < tag.length; offset += 1) blank(index + offset);
        index += tag.length;
        const end = sql.indexOf(tag, index);
        const limit = end < 0 ? sql.length : end + tag.length;
        while (index < limit) blank(index++);
        continue;
      }
    }
    index += 1;
  }
  return output.join('');
}

function statements(masked) {
  const output = [];
  let start = 0;
  for (let index = 0; index <= masked.length; index += 1) {
    if (index !== masked.length && masked[index] !== ';') continue;
    const text = masked.slice(start, index);
    if (text.trim()) output.push({ start, text });
    start = index + 1;
  }
  return output;
}

function addMatches(findings, masked, ruleId, expression) {
  expression.lastIndex = 0;
  for (const match of masked.matchAll(expression)) {
    findings.push({ ruleId, severity: 'high', line: lineNumber(masked, match.index), index: match.index });
  }
}

export function classifySqlRisks(sql) {
  if (typeof sql !== 'string') throw new Error('SQL input must be text');
  if (Buffer.byteLength(sql) > MAX_BYTES) throw new Error(`SQL input exceeds ${MAX_BYTES} bytes`);
  const masked = maskSqlLiteralsAndComments(sql);
  const findings = [];
  for (const [ruleId, expression] of DDL_RULES) addMatches(findings, masked, ruleId, expression);
  for (const statement of statements(masked)) {
    const deleteMatch = /\bdelete\s+from\b/i.exec(statement.text);
    if (deleteMatch && !/\bwhere\b/i.test(statement.text.slice(deleteMatch.index + deleteMatch[0].length))) {
      const index = statement.start + deleteMatch.index;
      findings.push({ ruleId: 'MIG_SQL_DELETE_WITHOUT_WHERE', severity: 'high', line: lineNumber(masked, index), index });
    }
    const updateMatch = /\bupdate\b[\s\S]*?\bset\b/i.exec(statement.text);
    if (updateMatch && !/\bwhere\b/i.test(statement.text.slice(updateMatch.index + updateMatch[0].length))) {
      const index = statement.start + updateMatch.index;
      findings.push({ ruleId: 'MIG_SQL_UPDATE_WITHOUT_WHERE', severity: 'high', line: lineNumber(masked, index), index });
    }
  }
  findings.sort((left, right) => left.index - right.index || left.ruleId.localeCompare(right.ruleId));
  return {
    schemaVersion: 1,
    inputBytes: Buffer.byteLength(sql),
    findings: findings.slice(0, MAX_FINDINGS).map(({ index: _index, ...finding }) => finding),
    truncated: findings.length > MAX_FINDINGS
  };
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--file') throw new Error('usage: classify-sql-risks.mjs --file <sql-file>');
  const file = path.resolve(argv[1]);
  if (statSync(file).size > MAX_BYTES) throw new Error(`SQL input exceeds ${MAX_BYTES} bytes`);
  process.stdout.write(`${JSON.stringify({ file: path.basename(file), ...classifySqlRisks(readFileSync(file, 'utf8')) }, null, 2)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`classify-sql-risks: ${error.message}\n`); process.exitCode = 1; }
}
