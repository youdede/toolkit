#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const NETWORK_HOSTLESS = new Set(['about:']);
const URL_KEY = /(url|uri|href|host|hostname|domain|origin|endpoint)s?$/;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:[\\/]{2}[^\s"'<>`]+/gi;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

class Refusal extends Error {
  constructor(ruleId) { super(ruleId); this.ruleId = ruleId; }
}

function allow(ruleId) {
  return { exitCode: 0, ruleId, message: null };
}

function block(ruleId, server = 'unknown') {
  return {
    exitCode: 2,
    ruleId,
    message: `Blocked by mcp-egress-guard [${ruleId}]: a ${server} tool call names a destination outside the server's declared egress; use a declared host or a reviewed server.`
  };
}

function normalizeHost(hostname) {
  return hostname.toLowerCase().replace(/\.$/, '');
}

// Resolve every identity the client reports; a youdede claim that is not an exact curated server fails closed.
function resolveServer(input, registry) {
  const names = Object.keys(registry?.servers || {});
  const segment = /^mcp__(.+?)__/.exec(typeof input.tool_name === 'string' ? input.tool_name : '')?.[1];
  const candidates = [segment, input.mcp_server?.name, input.mcp_server_name]
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase())
    .filter((value) => value.includes('youdede'));
  if (!candidates.length) {
    // Cursor beforeMCPExecution sends tool_input as a string; its docs ask hooks to deny a missing server key.
    return typeof input.tool_input === 'string' && !segment && input.mcp_server_name === undefined ? { unknown: true } : null;
  }
  const resolved = new Set(candidates.map((value) => names.find((name) => value === name || value.endsWith(`_${name}`))));
  if (resolved.size !== 1 || resolved.has(undefined)) return { unknown: true };
  return { name: [...resolved][0] };
}

function parseDestination(value, fromUrlField) {
  const raw = value.trim();
  let url;
  try {
    url = new URL(SCHEME.test(raw) ? raw : `https://${raw.replace(/^[\\/]+/, '')}`);
    if (!url.hostname && fromUrlField && !NETWORK_HOSTLESS.has(url.protocol) && url.protocol !== 'file:') {
      url = new URL(`https://${raw}`);
    }
  } catch {
    throw new Refusal('mcp-egress-url-invalid');
  }
  if (url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost')) return { file: url };
  if (!url.hostname) {
    if (NETWORK_HOSTLESS.has(url.protocol)) return null;
    throw new Refusal('mcp-egress-url-invalid');
  }
  return { host: normalizeHost(url.hostname) };
}

function collectDestinations(value, key, found, depth = 0) {
  if (depth > 64) throw new Refusal('mcp-egress-envelope-invalid');
  if (typeof value === 'string') {
    if (key && URL_KEY.test(key.toLowerCase().replace(/[-_]/g, '')) && value.trim()) found.push(parseDestination(value, true));
    for (const match of value.matchAll(URL_IN_TEXT)) found.push(parseDestination(match[0].replace(/[),.;\]]+$/, ''), false));
  } else if (Array.isArray(value)) {
    for (const item of value) collectDestinations(item, key, found, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectDestinations(childKey, null, found, depth + 1);
      collectDestinations(child, childKey, found, depth + 1);
    }
  }
  return found;
}

function insideWorkspace(fileUrl, workspace) {
  const relative = path.relative(path.resolve(workspace), path.resolve(fileURLToPath(fileUrl)));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function evaluate(input, registry, workspace = input?.cwd || process.cwd()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return block('mcp-egress-envelope-invalid');
  const server = resolveServer(input, registry);
  if (!server) return allow('mcp-egress-not-youdede');
  if (server.unknown) return block('mcp-egress-server-unknown');
  const declared = new Set((registry.servers[server.name].egress || []).map((host) => {
    try { return normalizeHost(new URL(`https://${host}`).hostname); } catch { return null; }
  }));
  let args = input.tool_input ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { /* scan the raw string as free text */ }
  }
  try {
    for (const destination of collectDestinations(args, null, [])) {
      if (!destination) continue;
      if (destination.file) {
        if (!insideWorkspace(destination.file, workspace)) return block('mcp-egress-file-outside-workspace', server.name);
      } else if (declared.has('none') || !declared.has(destination.host)) {
        return block('mcp-egress-undeclared-host', server.name);
      }
    }
  } catch (error) {
    return block(error instanceof Refusal ? error.ruleId : 'mcp-egress-guard-failure', server.name);
  }
  return allow('mcp-egress-declared');
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
    const registry = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-pins.json'), 'utf8'));
    const input = await receiveEnvelope();
    result = evaluate(input, registry, process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  } catch {
    result = block('mcp-egress-guard-failure');
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

function canonical(file) { try { return realpathSync(file); } catch { return ''; } }
if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) await main();
