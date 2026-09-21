#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArtifacts } from './lib/catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POISONING = /ignore\s+(?:all\s+)?previous|system\s+prompt|must\s+obey|developer\s+message|[\u202A-\u202E\u2066-\u2069]/iu;

export function descriptionHash(description) {
  return createHash('sha256').update(description).digest('hex');
}

export function compareObservedTools(pinnedTools, observedTools) {
  const expected = new Map(pinnedTools.map((tool) => [tool.name, tool.descriptionHash]));
  const observed = new Map((observedTools || []).map((tool) => [tool.name, descriptionHash(tool.description || '')]));
  return {
    missing: [...expected.keys()].filter((name) => !observed.has(name)).sort(),
    unknown: [...observed.keys()].filter((name) => !expected.has(name)).sort(),
    changed: [...expected].filter(([name, hash]) => observed.has(name) && observed.get(name) !== hash).map(([name]) => name).sort()
  };
}

export function verifyMcpRecord(record) {
  const errors = [];
  const { manifest } = record;
  const profileFile = path.join(record.directory, 'server.json');
  if (!existsSync(profileFile)) return ['server.json is missing'];
  const profile = JSON.parse(readFileSync(profileFile, 'utf8'));
  if (profile.serverName !== `youdede-${manifest.slug}`) errors.push('serverName does not match the artifact slug');
  if (profile.transport !== manifest.mcpServer.transport) errors.push('transport differs from the manifest');
  if (JSON.stringify(profile.egress) !== JSON.stringify(manifest.mcpServer.egress)) errors.push('egress differs from the manifest');
  if (JSON.stringify(profile.secretAccess) !== JSON.stringify(manifest.mcpServer.secretAccess)) errors.push('secretAccess differs from the manifest');
  if (profile.env && Object.keys(profile.env).length) errors.push('profiles may not embed environment values');
  const networked = manifest.mcpServer.egress.some((entry) => entry !== 'none');
  if (networked !== (profile.mode === 'allowlisted-fetch')) errors.push('network authority does not match the runtime mode');
  if (networked && JSON.stringify(profile.allowHosts) !== JSON.stringify(manifest.mcpServer.egress)) errors.push('allowHosts must exactly match declared egress');
  if (!networked && (profile.allowHosts?.length || profile.egress.join() !== 'none')) errors.push('closed-world profiles must have no host allowlist');
  if (profile.launch?.command !== 'node' || JSON.stringify(profile.launch?.args) !== JSON.stringify([
    '.youdede/mcp/runtime.mjs', '--profile', `.youdede/mcp/${manifest.slug}/server.json`
  ])) errors.push('launch command is outside the pinned local runtime contract');
  const names = new Set();
  for (const tool of profile.tools || []) {
    if (names.has(tool.name)) errors.push(`tool '${tool.name}' is duplicated`);
    names.add(tool.name);
    if (typeof tool.description !== 'string' || tool.description.length < 20 || POISONING.test(tool.description) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(tool.description)) errors.push(`tool '${tool.name}' has an unsafe description`);
    if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint !== false) errors.push(`tool '${tool.name}' is not declared read-only`);
    if (tool.annotations?.openWorldHint !== networked) errors.push(`tool '${tool.name}' has the wrong open-world annotation`);
  }
  const drift = compareObservedTools(manifest.mcpServer.pinnedTools, profile.tools);
  for (const kind of ['missing', 'unknown', 'changed']) if (drift[kind].length) errors.push(`${kind} tool pins: ${drift[kind].join(', ')}`);
  for (const [target, adapter] of Object.entries(record.adapters)) {
    const entries = adapter.data.mcpPatch?.servers || {};
    if (JSON.stringify(entries[profile.serverName]) !== JSON.stringify(profile.launch)) errors.push(`${target} MCP config differs from server.json launch`);
  }
  if (!existsSync(path.join(record.directory, 'THREAT.md'))) errors.push('THREAT.md is missing');
  return errors;
}

export function verifyMcp(root = ROOT) {
  const failures = [];
  for (const record of loadArtifacts(root).filter(({ manifest }) => manifest.kind === 'mcp-server')) {
    for (const error of verifyMcpRecord(record)) failures.push(`${record.manifest.id}: ${error}`);
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const failures = verifyMcp();
    if (failures.length) throw new Error(failures.join('\n'));
    process.stdout.write('Verified MCP trust contracts.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
