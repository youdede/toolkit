#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArtifacts } from './lib/catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'scripts/runtime/readonly-mcp-server.mjs');
const REGISTRY = path.join(ROOT, 'catalog/mcp-pins.json');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function expectedMcpOutputs(root = ROOT) {
  const runtime = readFileSync(path.join(root, 'scripts/runtime/readonly-mcp-server.mjs'));
  const servers = {};
  const outputs = new Map();
  for (const record of loadArtifacts(root).filter(({ manifest }) => manifest.kind === 'mcp-server')) {
    const profileFile = path.join(record.directory, 'server.json');
    const profile = JSON.parse(readFileSync(profileFile, 'utf8'));
    if (profile.mode !== 'external-vendor') outputs.set(path.join(record.directory, 'runtime/readonly-mcp-server.mjs'), runtime);
    servers[profile.serverName] = {
      artifactId: record.manifest.id,
      profileSha256: sha256(readFileSync(profileFile)),
      tools: Object.fromEntries(profile.tools.map((tool) => [tool.name, sha256(tool.description)]))
    };
  }
  const registry = {
    schemaVersion: 1,
    generatedBy: 'scripts/generate-mcp.mjs',
    servers: Object.fromEntries(Object.entries(servers).sort(([left], [right]) => left.localeCompare(right)))
  };
  outputs.set(path.join(root, 'catalog/mcp-pins.json'), Buffer.from(`${JSON.stringify(registry, null, 2)}\n`));
  return outputs;
}

export function generateMcp({ root = ROOT, check = false } = {}) {
  const stale = [];
  for (const [file, expected] of expectedMcpOutputs(root)) {
    const actual = existsSync(file) ? readFileSync(file) : null;
    if (actual?.equals(expected)) continue;
    stale.push(path.relative(root, file));
    if (!check) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, expected);
    }
  }
  if (check && stale.length) throw new Error(`generated MCP outputs are stale: ${stale.join(', ')}`);
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const stale = generateMcp({ check: process.argv.includes('--check') });
    process.stdout.write(`${stale.length ? `Updated ${stale.length}` : 'Verified'} MCP generated output${stale.length === 1 ? '' : 's'}.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
