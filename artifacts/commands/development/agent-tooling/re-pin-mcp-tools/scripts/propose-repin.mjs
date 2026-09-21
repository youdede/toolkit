#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 64 * 1024;

function option(name, argv) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : null;
}

function readBoundedJson(file) {
  const real = realpathSync(file);
  if (!statSync(real).isFile() || statSync(real).size > MAX_BYTES) throw new Error('input must be a regular JSON file no larger than 64 KiB');
  const value = JSON.parse(readFileSync(real, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input JSON root must be an object');
  return value;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildProposal(registry, server, observation) {
  if (!/^youdede-[a-z0-9-]+$/.test(server || '')) throw new Error('server must be one exact Youdede server name');
  const current = registry.servers?.[server];
  if (!current) throw new Error('server is absent from the current registry');
  const tools = observation.result?.tools || observation.tools;
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > 64) throw new Error('observation must contain 1-64 tools');
  const pins = tools.map((tool) => {
    if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(tool?.name || '') || typeof tool?.description !== 'string' || tool.description.length < 20) throw new Error('every observed tool needs a valid name and bounded description');
    return { name: tool.name, descriptionHash: hash(tool.description) };
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(pins.map(({ name }) => name)).size !== pins.length) throw new Error('observed tool names must be unique');
  const proposal = { schemaVersion: 1, server, previousTools: current.tools, proposedTools: Object.fromEntries(pins.map(({ name, descriptionHash }) => [name, descriptionHash])) };
  return { ...proposal, confirmationDigest: hash(JSON.stringify(proposal)) };
}

export function main(argv = process.argv.slice(2)) {
  const server = option('server', argv);
  const observed = option('observed', argv);
  const registry = option('registry', argv) || path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'mcp-pins.json');
  if (!server || !observed) throw new Error('usage: propose-repin --server <name> --observed <tools-list.json> [--registry <pins.json>]');
  process.stdout.write(`${JSON.stringify(buildProposal(readBoundedJson(registry), server, readBoundedJson(observed)), null, 2)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
