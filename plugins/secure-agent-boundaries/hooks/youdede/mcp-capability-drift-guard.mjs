#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Every server identity the client reports: the Claude Code tool name (`mcp__<server>__<tool>`, or
// `mcp__plugin_<plugin>_<server>__<tool>` for a plugin server) and `mcp_server.name`, the Cursor
// `mcp_server_name` with a bare `tool_name`, or the portable `<server>:<tool>`. Names are compared
// case-insensitively, so a Youdede claim in any case is resolved or refused.
function parseToolIdentity(input, registry) {
  const raw = input.tool_name ?? input.toolName ?? input.tool ?? '';
  if (typeof raw !== 'string') return { unknown: true };
  const claude = /^mcp__(.+?)__(.+)$/.exec(raw);
  const portable = claude ? null : /^([^:\s]+):(.+)$/.exec(raw);
  const tool = claude?.[2] ?? portable?.[2] ?? raw;
  const candidates = [claude?.[1], portable?.[1], input.mcp_server?.name, input.mcp_server_name]
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase())
    .filter((value) => value.includes('youdede'));
  if (!candidates.length) return null;
  const names = Object.keys(registry?.servers || {});
  const resolved = new Set(candidates.map((value) => names.find((name) => value === name || value.endsWith(`_${name}`))));
  const server = candidates.find((value) => value.startsWith('youdede')) ?? candidates[0];
  if (resolved.size !== 1 || resolved.has(undefined)) return { unknown: true, server };
  return { server: [...resolved][0], tool };
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
  const identity = parseToolIdentity(input, registry);
  if (!identity) return allow();
  if (identity.unknown) return block('mcp-server-unpinned', identity.server);
  const pinned = registry.servers[identity.server];
  const expected = Object.hasOwn(pinned.tools || {}, identity.tool) ? pinned.tools[identity.tool] : undefined;
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
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
