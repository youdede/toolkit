#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Hand-written documents quote catalog figures, and every bulk change left some
// of them stale. Like the catalog docs, the figures are now generated: markers
// in the markdown delimit each number or table, this script rewrites what sits
// between them from the artifact manifests, and `--check` refuses drift so a
// push cannot ship a stale count.

import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArtifacts, ROOT, validateRepository } from './lib/catalog.mjs';
import { SUPPORTED_TARGETS, targetDefinition } from './lib/targets.mjs';

const KINDS = ['skill', 'hook', 'subagent'];
const EXPECTED_MARKERS = {
  'README.md': {
    stat: { 'artifact-count': 1, 'evaluation-case-count': 1, 'hook-count': 2, 'skill-count': 2, 'subagent-count': 2 },
    table: { 'readme-matrix': 1 },
  },
  'docs/targets.md': { stat: {}, table: { targets: 1 } },
  'docs/publishing-checklist.md': { stat: { 'artifact-count': 2 }, table: {} },
  'docs/architecture.md': { stat: {}, table: {} },
  'docs/install.md': { stat: {}, table: {} },
};
const FILES = Object.keys(EXPECTED_MARKERS);

function countMatches(content, pattern, keyPrefix = '') {
  const counts = new Map();
  for (const match of content.matchAll(pattern)) {
    const key = `${keyPrefix}${match[1]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export function validateMarkerInventory(content, file) {
  const expected = EXPECTED_MARKERS[file];
  if (!expected) throw new Error(`${file}: no marker inventory declared`);

  const scalar = countMatches(content, /<!-- stat:([a-z-]+(?::[a-z-]+)?) -->/g, 'stat:');
  const tables = countMatches(content, /<!-- stat-table:([a-z-]+) -->/g, 'table:');
  const actual = new Map([...scalar, ...tables]);
  const declared = new Map([
    ...Object.entries(expected.stat).map(([key, count]) => [`stat:${key}`, count]),
    ...Object.entries(expected.table).map(([key, count]) => [`table:${key}`, count]),
  ]);
  const errors = [];
  for (const key of [...new Set([...declared.keys(), ...actual.keys()])].sort()) {
    const expectedCount = declared.get(key) || 0;
    const actualCount = actual.get(key) || 0;
    if (expectedCount !== actualCount) errors.push(`${key} expected ${expectedCount}, found ${actualCount}`);
  }

  const scalarClosings = (content.match(/<!-- \/stat -->/g) || []).length;
  const tableClosings = (content.match(/<!-- \/stat-table -->/g) || []).length;
  const scalarOpenings = [...scalar.values()].reduce((sum, count) => sum + count, 0);
  const tableOpenings = [...tables.values()].reduce((sum, count) => sum + count, 0);
  if (scalarOpenings !== scalarClosings) errors.push(`scalar marker openings ${scalarOpenings}, closings ${scalarClosings}`);
  if (tableOpenings !== tableClosings) errors.push(`table marker openings ${tableOpenings}, closings ${tableClosings}`);
  if (errors.length > 0) throw new Error(`${file}: invalid stat marker inventory: ${errors.join('; ')}`);
}

function computeStats() {
  const artifacts = loadArtifacts(ROOT);
  const { packs } = validateRepository();
  const byKind = Object.fromEntries(KINDS.map((kind) => [kind, artifacts.filter(({ manifest }) => manifest.kind === kind)]));
  const stats = {
    'artifact-count': String(artifacts.length),
    'skill-count': String(byKind.skill.length),
    'hook-count': String(byKind.hook.length),
    'subagent-count': String(byKind.subagent.length),
    'pack-count': String(packs.length),
    'target-count': String(SUPPORTED_TARGETS.length),
    'evaluation-case-count': String(artifacts.reduce((total, { directory }) => {
      const file = path.join(directory, 'evaluations', 'behavioral.json');
      return existsSync(file) ? total + JSON.parse(readFileSync(file, 'utf8')).cases.length : total;
    }, 0)),
  };
  for (const target of SUPPORTED_TARGETS) {
    for (const kind of KINDS) {
      stats[`${kind}-count:${target}`] = String(byKind[kind].filter(({ adapters }) => adapters[target]).length);
    }
  }
  return stats;
}

// The per-target table in docs/targets.md is regenerated whole: counts come
// from the manifests, labels from the target definitions, and the root notes
// live here because the resolved roots are machine paths, not documentation.
const ROOT_NOTES = {
  'claude-code': { project: '`.claude`', user: '`~/.claude`' },
  codex: { project: 'skills: `.agents`; hooks/agents: `.codex`', user: 'skills: `~/.agents`; hooks/agents: `~/.codex`' },
  'gemini-cli': { project: '`.gemini`', user: '`~/.gemini`' },
  'github-copilot': { project: '`.github`', user: '`$COPILOT_HOME` or `~/.copilot`' },
  cursor: { project: '`.cursor`', user: '`~/.cursor`' },
  opencode: { project: '`.opencode`', user: '`~/.config/opencode`' },
};

function targetsTable(stats) {
  const lines = [
    '| Target | Skills | Hooks | Subagents | Project root | User root |',
    '| --- | ---: | ---: | ---: | --- | --- |'
  ];
  for (const target of SUPPORTED_TARGETS) {
    const notes = ROOT_NOTES[target];
    if (!notes) throw new Error(`docs/targets.md: no root note declared for target "${target}"`);
    lines.push(`| ${targetDefinition(target).label} | ${stats[`skill-count:${target}`]} | ${stats[`hook-count:${target}`]} | ${stats[`subagent-count:${target}`]} | ${notes.project} | ${notes.user} |`);
  }
  return lines.join('\n');
}

// The README coverage matrix lists targets as columns, one row per kind.
function readmeMatrix(stats) {
  const kinds = [['skill', 'Skills'], ['hook', 'Hooks'], ['subagent', 'Subagents']];
  return kinds.map(([kind, label]) => {
    const cells = SUPPORTED_TARGETS.map((target) => stats[`${kind}-count:${target}`]);
    return `| ${label} (${stats[`${kind}-count`]}) | ${cells.join(' | ')} |`;
  }).join('\n');
}

function render(content, stats, file) {
  const replaced = content
    .replace(/(<!-- stat:([a-z-]+(?::[a-z-]+)?) -->)([\s\S]*?)(<!-- \/stat -->)/g, (whole, open, key, _old, close) => {
      if (!(key in stats)) throw new Error(`${file}: unknown stat marker "${key}"`);
      return `${open}${stats[key]}${close}`;
    })
    .replace(/(<!-- stat-table:targets -->\n)([\s\S]*?)(\n<!-- \/stat-table -->)/g, (whole, open, _old, close) => `${open}${targetsTable(stats)}${close}`)
    .replace(/(<!-- stat-table:readme-matrix -->\n)([\s\S]*?)(\n<!-- \/stat-table -->)/g, (whole, open, _old, close) => `${open}${readmeMatrix(stats)}${close}`)
    .replace(/badge\/artifacts-\d+-/g, `badge/artifacts-${stats['artifact-count']}-`);
  return replaced;
}

export function main(argv = process.argv.slice(2)) {
  for (const option of argv) if (option !== '--check') throw new Error(`unknown argument '${option}'`);
  const check = argv.includes('--check');
  const stats = computeStats();
  let stale = 0;
  for (const relative of FILES) {
    const file = path.join(ROOT, relative);
    const content = readFileSync(file, 'utf8');
    validateMarkerInventory(content, relative);
    const next = render(content, stats, relative);
    if (next === content) continue;
    if (check) {
      stale += 1;
      process.stderr.write(`${relative}: documented figures are stale; run npm run docs:stats.\n`);
    } else {
      writeFileSync(file, next);
      process.stdout.write(`Updated ${relative}.\n`);
    }
  }
  if (check) {
    if (stale > 0) process.exitCode = 1;
    else process.stdout.write(`Documented figures match the ${stats['artifact-count']} artifact manifests.\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
