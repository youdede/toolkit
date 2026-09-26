#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function scalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

// Top-level fields only; nested maps such as `metadata` are recorded without their children.
function frontmatter(raw) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!match) return null;
  const fields = {};
  const lines = match[1].split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(lines[index]);
    if (!field) continue;
    const block = /^([|>])[-+0-9]*$/.exec(field[2].trim());
    if (!block) { fields[field[1]] = scalar(field[2]); continue; }
    const parts = [];
    while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]) || lines[index + 1] === '')) parts.push(lines[++index].trim());
    fields[field[1]] = parts.join(block[1] === '>' ? ' ' : '\n').trim();
  }
  return fields;
}

function localLinks(raw) {
  return [...raw.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, '').split('#')[0])
    .filter((target) => target && !/^(?:[a-z]+:|#)/i.test(target));
}

export function validateSkill(directory) {
  const root = path.resolve(directory);
  const file = path.join(root, 'SKILL.md');
  const errors = [];
  if (!existsSync(file)) return { valid: false, errors: ['SKILL.md is missing'] };
  const raw = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  const fields = frontmatter(raw);
  if (!fields) errors.push('SKILL.md requires YAML frontmatter');
  else {
    const expected = path.basename(root);
    if (fields.name !== expected) errors.push(`frontmatter name must match folder '${expected}'`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name || '') || String(fields.name || '').length > 64) errors.push('name must be lowercase hyphen-case with at most 64 characters');
    if (typeof fields.description !== 'string' || fields.description.length < 40 || fields.description.length > 1024) errors.push('description must contain 40-1024 characters');
    // The frontmatter fields of the Agent Skills specification (agentskills.io/specification).
    const unsupported = Object.keys(fields).filter((key) => !['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(key));
    if (typeof fields.compatibility === 'string' && fields.compatibility.length > 500) errors.push('compatibility must contain at most 500 characters');
    if (unsupported.length) errors.push(`unsupported frontmatter fields: ${unsupported.join(', ')}`);
  }
  if (!raw.includes('## Validation')) errors.push('SKILL.md must document Validation');
  if (!raw.includes('## Refusals')) errors.push('SKILL.md must document Refusals');
  if (/\bTODO\b|\[TODO/.test(raw)) errors.push('SKILL.md contains TODO placeholders');
  for (const target of localLinks(raw)) {
    const absolute = path.resolve(root, target);
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) errors.push(`link escapes skill folder: ${target}`);
    else if (!existsSync(absolute)) errors.push(`linked resource is missing: ${target}`);
  }
  return { valid: errors.length === 0, errors };
}

function main() {
  const directory = process.argv[2];
  if (!directory || process.argv.length !== 3) throw new Error('usage: validate-skill.mjs <skill-directory>');
  const result = validateSkill(directory);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    process.stderr.write(`validate-skill: ${error.message}\n`);
    process.exitCode = 1;
  }
}
