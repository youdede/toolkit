#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseToolIdentity(input) {
  const raw = input.tool_name || input.toolName || input.tool || '';
  if (typeof raw !== 'string') return null;
  const claude = /^mcp__(youdede-[a-z0-9-]+)__([a-z0-9_-]+)$/.exec(raw);
  const portable = /^(youdede-[a-z0-9-]+):([a-z0-9_-]+)$/.exec(raw);
  const match = claude || portable;
  return match ? { server: match[1], tool: match[2] } : null;
}

function allow() {
  return { exitCode: 0, ruleId: 'mcp-capability-pinned', message: null };
}

function block(ruleId, server = 'unknown') {
  return {
    exitCode: 2,
    ruleId,
    message: `Blocked by mcp-capability-drift-guard [${ruleId}]: the ${server} capability contract is not pinned; run the sanctioned re-pin review before use.`
  };
}

export function evaluate(input, registry) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return block('mcp-envelope-invalid');
  const identity = parseToolIdentity(input);
  if (!identity) return allow();
  const pinned = registry?.servers?.[identity.server];
  if (!pinned) return block('mcp-server-unpinned', identity.server);
  const expected = pinned.tools?.[identity.tool];
  if (!expected) return block('mcp-tool-unpinned', identity.server);
  const description = input.tool_description ?? input.toolDescription;
  if (description !== undefined && (typeof description !== 'string' || sha256(description) !== expected)) {
    return block('mcp-description-drift', identity.server);
  }
  const observed = input.observed_tools ?? input.observedTools;
  if (observed !== undefined) {
    if (!Array.isArray(observed)) return block('mcp-inventory-invalid', identity.server);
    const actual = new Map(observed.map((tool) => [tool?.name, typeof tool?.description === 'string' ? sha256(tool.description) : '']));
    const expectedTools = Object.entries(pinned.tools || {});
    if (actual.size !== expectedTools.length || expectedTools.some(([name, hash]) => actual.get(name) !== hash)) {
      return block('mcp-inventory-drift', identity.server);
    }
  }
  return allow();
}

async function receiveEnvelope() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error('input-limit');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('envelope-invalid');
  return value;
}

async function main() {
  let result;
  try {
    const registryFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-pins.json');
    const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
    result = evaluate(await receiveEnvelope(), registry);
  } catch {
    result = block('mcp-guard-failure');
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

function canonical(file) { try { return realpathSync(file); } catch { return ''; } }
if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) await main();
