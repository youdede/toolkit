#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024;

// Claude Code passes absolute file paths, and its cwd follows `cd`, so the workflow is recognized
// from the resolved path: <root>/.github/workflows/<name>.yml, whatever the current directory.
const WORKFLOW_PATH = /^(.*?)[\\/]\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/i;

function workflowTarget(value, base) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  const target = path.resolve(base, value);
  const match = WORKFLOW_PATH.exec(target);
  return match ? { target, root: match[1] || path.parse(target).root } : null;
}

function stripComment(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote && line[index - 1] !== '\\') quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '#') return line.slice(0, index);
  }
  return line;
}

function immutableImage(reference) {
  return /@sha256:[a-f0-9]{64}$/i.test(reference);
}

// A finding's identity is its rule and normalized reference, so replacing one mutable reference
// with another is a new finding.
export function scanReferences(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) {
    throw new Error('workflow content is invalid or oversized');
  }
  const findings = [];
  const keys = [];
  const add = (ruleId, reference, offset) => findings.push({ ruleId, reference, line: offset + 1 });
  const checkImage = (reference, offset) => {
    if (!reference || reference.startsWith('{') || reference.startsWith('|') || reference.startsWith('>')) return;
    if (reference.includes('${{')) add('ci-reference-dynamic', reference, offset);
    else if (!immutableImage(reference)) add('ci-container-reference-mutable', reference, offset);
  };
  for (const [offset, raw] of content.split(/\r?\n/).entries()) {
    const line = stripComment(raw);
    // Mapping keys by indentation: jobs.<id>.container and jobs.<id>.services.<id>.image.
    const key = /^(\s*)(?:-\s+)?([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (key) {
      const indent = key[1].length;
      while (keys.length && keys.at(-1).indent >= indent) keys.pop();
      keys.push({ name: key[2], indent });
      const names = keys.map((entry) => entry.name);
      const value = key[3].replace(/^(['"])(.*)\1$/, '$2').trim();
      const underJob = names[0] === 'jobs' && names.length >= 3;
      if (underJob && names.length === 3 && key[2] === 'container') {
        const flow = /(?:^\{|,)\s*image\s*:\s*([^,}]+)/.exec(value);
        checkImage(flow ? flow[1].replace(/^(['"])(.*)\1$/, '$2').trim() : value, offset);
      }
      if (underJob && key[2] === 'image' && ((names.length === 4 && names[2] === 'container') || (names.length === 5 && names[2] === 'services'))) checkImage(value, offset);
      if (underJob && names.length === 4 && names[2] === 'services') {
        const flow = /(?:^\{|,)\s*image\s*:\s*([^,}]+)/.exec(value);
        if (flow) checkImage(flow[1].replace(/^(['"])(.*)\1$/, '$2').trim(), offset);
      }
    }
    const ordinary = /^\s*(?:-\s*)?uses\s*:\s*(.*?)\s*$/i.exec(line);
    const flow = /(?:^|[{,])\s*uses\s*:\s*([^,}]+)(?=\s*[,}])/i.exec(line);
    const match = ordinary || flow;
    if (!match) continue;
    const reference = match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
    if (reference.startsWith('./')) continue;
    if (reference.includes('${{')) {
      add('ci-reference-dynamic', reference, offset);
      continue;
    }
    if (reference.toLowerCase().startsWith('docker://')) {
      if (!immutableImage(reference)) add('ci-container-reference-mutable', reference, offset);
      continue;
    }
    const delimiter = reference.lastIndexOf('@');
    const revision = delimiter < 0 ? '' : reference.slice(delimiter + 1);
    if (!/^[a-f0-9]{40}$/i.test(revision)) add('ci-reference-mutable', reference, offset);
  }
  return findings;
}

function subtract(before, after) {
  const identity = (finding) => `${finding.ruleId}\0${finding.reference}`;
  const counts = new Map();
  for (const finding of before) counts.set(identity(finding), (counts.get(identity(finding)) || 0) + 1);
  return after.filter((finding) => {
    const count = counts.get(identity(finding)) || 0;
    if (count === 0) return true;
    counts.set(identity(finding), count - 1);
    return false;
  });
}

function proposedContent(toolInput, existing) {
  if (typeof toolInput?.content === 'string') return toolInput.content;
  if (Array.isArray(toolInput?.edits)) {
    let result = existing;
    for (const edit of toolInput.edits) result = applyEdit(result, edit);
    return result;
  }
  return applyEdit(existing, toolInput);
}

function applyEdit(existing, edit) {
  if (typeof edit?.old_string !== 'string' || !edit.old_string || typeof edit?.new_string !== 'string') {
    throw new Error('edit shape is incomplete');
  }
  const pieces = existing.split(edit.old_string);
  if (edit.replace_all === true) {
    if (pieces.length === 1) throw new Error('edit target is absent');
    return pieces.join(edit.new_string);
  }
  if (pieces.length !== 2) throw new Error('edit target is not unique');
  return pieces.join(edit.new_string);
}

export function collectContext(input, cwd = process.cwd()) {
  const toolInput = input?.tool_input || input?.toolInput || {};
  const rawPath = toolInput.file_path || toolInput.file;
  const workflow = workflowTarget(rawPath, path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd));
  if (!workflow) return { relevant: false };
  try {
    const { root, target } = workflow;
    let cursor = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (!existsSync(cursor)) break;
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('workflow path traverses a symlink');
    }
    let existing = '';
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('unsafe workflow target');
      existing = readFileSync(target, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { relevant: true, before: existing, after: proposedContent(toolInput, existing) };
  } catch {
    return { relevant: true, inspectionError: true };
  }
}

export function evaluate(_input, context = {}) {
  if (!context.relevant) return { exitCode: 0 };
  if (context.inspectionError) return { exitCode: 2, ruleId: 'ci-reference-inspection-incomplete', message: 'CI reference pinning could not inspect the complete proposed file.' };
  try {
    const added = subtract(scanReferences(context.before || ''), scanReferences(context.after));
    if (!added.length) return { exitCode: 0 };
    return { exitCode: 2, ruleId: added[0].ruleId, message: 'The proposed workflow adds a non-immutable external execution reference.' };
  } catch {
    return { exitCode: 2, ruleId: 'ci-reference-input-invalid', message: 'CI reference pinning received invalid or oversized workflow content.' };
  }
}

async function main() {
  try {
    const raw = await new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      process.stdin.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_STDIN_BYTES) reject(new Error('input exceeds the bounded limit'));
        else chunks.push(chunk);
      });
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    });
    const input = JSON.parse(raw);
    const result = evaluate(input, collectContext(input));
    if (result.exitCode) process.stderr.write(`[${result.ruleId}] ${result.message}\n`);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
