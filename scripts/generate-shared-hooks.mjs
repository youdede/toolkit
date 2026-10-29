#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Copies the shared hook modules of scripts/lib/shared-hook/ into every hook payload under
// artifacts/ and every runtime under scripts/runtime/, between `// <youdede:shared <name>>` and `// </youdede:shared>`. An installed hook stays
// one self-contained file. With --check it only reports payloads whose copy is stale. A broken,
// nested, duplicate, or unknown marker, or a block whose dependency block is missing, fails.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_DIRECTORY = path.join(ROOT, 'scripts', 'lib', 'shared-hook');
const OPEN = /^\/\/ <youdede:shared ([a-z0-9-]+)>$/;
const CLOSE = /^\/\/ <\/youdede:shared>$/;
const DEPENDENCY = /^import\s*\{[^}]*\}\s*from\s*'\.\/([a-z0-9-]+)\.mjs';\n/gm;

// name -> { body, requires }. The body is the module without its imports of sibling modules.
export function loadSharedModules(directory = MODULE_DIRECTORY) {
  const modules = new Map();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.mjs')).sort()) {
    const source = readFileSync(path.join(directory, file), 'utf8');
    const requires = [...source.matchAll(DEPENDENCY)].map((match) => match[1]);
    const body = `${source.replace(DEPENDENCY, '').trimEnd()}\n`;
    if (/^import\s/m.test(body)) throw new Error(`${file}: a shared module may import only sibling shared modules`);
    if (body.includes('youdede:shared')) throw new Error(`${file}: a shared module may not contain the block marker text`);
    modules.set(file.slice(0, -'.mjs'.length), { body, requires });
  }
  return modules;
}

// Returns { text, blocks, errors } with every marked block replaced by its module body.
export function renderSharedBlocks(source, modules) {
  const lines = source.split('\n');
  const output = [];
  const blocks = [];
  const errors = [];
  let open = null;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const opening = OPEN.exec(trimmed);
    const closing = CLOSE.test(trimmed);
    if (!opening && !closing && trimmed.includes('youdede:shared')) errors.push(`line ${index + 1}: malformed shared marker`);
    if (opening) {
      if (open) errors.push(`line ${index + 1}: shared block ${opening[1]} opens inside ${open.name}`);
      else {
        const name = opening[1];
        if (!modules.has(name)) errors.push(`line ${index + 1}: unknown shared module ${name}`);
        if (blocks.includes(name)) errors.push(`line ${index + 1}: duplicate shared block ${name}`);
        blocks.push(name);
        open = { name, line: index + 1 };
        output.push(line);
      }
      return;
    }
    if (closing) {
      if (!open) errors.push(`line ${index + 1}: shared block closes without an opening marker`);
      else {
        output.push(...(modules.get(open.name)?.body ?? '\n').slice(0, -1).split('\n'), line);
        open = null;
      }
      return;
    }
    if (!open) output.push(line);
  });
  if (open) errors.push(`line ${open.line}: shared block ${open.name} is not closed`);
  for (const name of blocks) {
    for (const dependency of modules.get(name)?.requires ?? []) {
      if (!blocks.includes(dependency)) errors.push(`shared block ${name} requires the ${dependency} block in the same file`);
    }
  }
  return { text: output.join('\n'), blocks, errors };
}

function listPayloads(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const next = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listPayloads(next));
    else if (/\.(?:mjs|js)$/.test(entry.name)) files.push(next);
  }
  return files;
}

export function generateSharedHooks({ check = false, root = ROOT } = {}) {
  const modules = loadSharedModules(path.join(root, 'scripts', 'lib', 'shared-hook'));
  const problems = [];
  const stale = [];
  let embedded = 0;
  for (const file of ['artifacts', 'scripts/runtime'].flatMap((directory) => listPayloads(path.join(root, directory)))) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('youdede:shared')) continue;
    const relative = path.relative(root, file).split(path.sep).join('/');
    const rendered = renderSharedBlocks(source, modules);
    if (rendered.errors.length) {
      problems.push(...rendered.errors.map((error) => `${relative}: ${error}`));
      continue;
    }
    embedded += 1;
    if (rendered.text === source) continue;
    stale.push(relative);
    if (!check) writeFileSync(file, rendered.text);
  }
  return { problems, stale, embedded };
}

function main() {
  const check = process.argv.includes('--check');
  const { problems, stale, embedded } = generateSharedHooks({ check });
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  if (check) for (const file of stale) process.stderr.write(`${file}: shared hook block is stale; run npm run shared-hooks\n`);
  if (problems.length || (check && stale.length)) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${embedded} files carry shared blocks${check ? '' : `, ${stale.length} updated`}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
