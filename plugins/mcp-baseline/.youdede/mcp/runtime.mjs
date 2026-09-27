#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_WALK_ENTRIES = 2000;
// Newest first. Only versions whose initialize, tools/list, and tools/call shapes this server
// implements unchanged; the source and date are in the pull request. 2026-07-28 is excluded because
// it removes initialize, and 2025-03-26 because it requires receiving JSON-RPC batches, which this
// server rejects as an invalid request. A client asking for 2025-03-26 is offered the newest version.
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2024-11-05']);
const PRIVATE_DIRECTORIES = new Set(['.git', '.youdede', '.youdede-toolkit']);
const isPrivateDirectory = (name) => PRIVATE_DIRECTORIES.has(name.toLowerCase());
const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];
// A credential directory is sensitive itself and so is everything under it, at any depth; `.ssh` keeps
// its own rule because its public keys, config, and known_hosts are safe.
const SENSITIVE_DIRECTORY_SUFFIXES = ['/.aws', '/.azure', '/.config/gcloud', '/.gnupg', '/.kube', '/.ssh'];
const SAFE_SSH_FILES = new Set(['authorized_keys', 'config', 'known_hosts']);
const EXACT_CREDENTIAL_SUFFIXES = [
  '/.aws/credentials',
  '/.azure/accessTokens.json',
  '/.config/gcloud/application_default_credentials.json',
  '/.config/gh/hosts.yml',
  '/.docker/config.json',
  '/.git-credentials',
  '/.kube/config',
  '/.netrc',
  '/.npmrc',
  '/.pypirc'
].map((entry) => entry.toLowerCase());
const SSH_PRIVATE_KEY = /\/(?:\.ssh\/)?id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i;
const MODES = Object.freeze({
  'workspace-files': new Set(['read_file', 'list_directory', 'search_files']),
  'repository-git': new Set(['git_status', 'git_diff', 'git_log']),
  'allowlisted-fetch': new Set(['fetch_url'])
});

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function cleanGitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
}

function safeRelative(value, label = 'path') {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')
    || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) {
    throw new Error(`${label} must be a portable relative path`);
  }
  return value;
}

function rejectPrivatePath(workspace, candidate) {
  if (path.relative(workspace, candidate).split(path.sep).some(isPrivateDirectory)) {
    throw new Error('path enters a protected workspace directory');
  }
}

// Same rules as sensitive-file-access-guard; tests/mcp-trust.test.mjs compares the two. The
// runtime is copied alone into user projects, so it cannot import the guard.
export function isSensitiveWorkspacePath(relative) {
  const normalized = `/${String(relative).replaceAll('\\', '/').split('/').filter((part) => part && part !== '.').join('/')}`.toLowerCase();
  const basename = normalized.split('/').at(-1);
  if (basename.startsWith('.env') && SAFE_ENV_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return false;
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (SSH_PRIVATE_KEY.test(normalized)) return true;
  if (normalized.includes('/.ssh/') && !basename.endsWith('.pub') && !SAFE_SSH_FILES.has(basename)) return true;
  if (SENSITIVE_DIRECTORY_SUFFIXES.some((suffix) => normalized.endsWith(suffix) || (suffix !== '/.ssh' && normalized.includes(`${suffix}/`)))) return true;
  return EXACT_CREDENTIAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function rejectSensitivePath(workspace, candidate) {
  if (isSensitiveWorkspacePath(path.relative(workspace, candidate))) {
    throw new Error('path is a credential file that this profile declares no access to');
  }
}

function existingWorkspacePath(workspace, relative, { directory = false } = {}) {
  const target = path.resolve(workspace, safeRelative(relative));
  if (!within(workspace, target)) throw new Error('path escapes the workspace');
  rejectPrivatePath(workspace, target);
  rejectSensitivePath(workspace, target);
  const resolved = realpathSync(target);
  if (!within(workspace, resolved)) throw new Error('path resolves outside the workspace');
  rejectPrivatePath(workspace, resolved);
  rejectSensitivePath(workspace, resolved);
  const metadata = statSync(resolved);
  if (directory ? !metadata.isDirectory() : !metadata.isFile()) throw new Error(directory ? 'path is not a directory' : 'path is not a file');
  return { resolved, metadata };
}

function boundedText(buffer, limit = MAX_RESULT_BYTES) {
  if (buffer.length > limit) throw new Error(`result exceeds ${limit} bytes`);
  return buffer.toString('utf8');
}

function readProfile(file) {
  const workspace = realpathSync(process.cwd());
  const absolute = path.resolve(workspace, safeRelative(file, 'profile path'));
  if (!within(workspace, absolute)) throw new Error('profile path escapes the workspace');
  if (lstatSync(absolute).isSymbolicLink()) throw new Error('profile may not be a symbolic link');
  const resolved = realpathSync(absolute);
  if (!within(workspace, resolved)) throw new Error('profile resolves outside the workspace');
  const metadata = statSync(resolved);
  if (!metadata.isFile() || metadata.size > MAX_PROFILE_BYTES) throw new Error('profile must be a bounded regular file');
  const profile = JSON.parse(readFileSync(resolved, 'utf8'));
  const allowed = MODES[profile.mode];
  if (profile.schemaVersion !== 1 || !allowed || !Array.isArray(profile.tools) || profile.tools.length !== allowed.size) throw new Error('profile contract is invalid');
  const names = new Set(profile.tools.map(({ name }) => name));
  if (names.size !== allowed.size || [...names].some((name) => !allowed.has(name))) throw new Error('profile tool set does not match its mode');
  if (!Array.isArray(profile.egress) || !Array.isArray(profile.secretAccess)) throw new Error('profile authority declaration is invalid');
  const allowHosts = Array.isArray(profile.allowHosts) ? profile.allowHosts : [];
  if (profile.mode === 'allowlisted-fetch') {
    if (allowHosts.length === 0 || allowHosts.some((host) => !profile.egress.includes(host))) throw new Error('fetch profile allowlist and egress declaration disagree');
  } else if (allowHosts.length > 0 || profile.egress.length !== 1 || profile.egress[0] !== 'none') {
    throw new Error('closed-world profile may not declare network egress');
  }
  return { profile, workspace };
}

function walk(directory, workspace, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (output.length >= MAX_WALK_ENTRIES) break;
    if (isPrivateDirectory(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(workspace, absolute).split(path.sep).join('/');
    if (isSensitiveWorkspacePath(relative)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(absolute, workspace, output);
    else if (entry.isFile()) output.push(relative);
  }
  return output;
}

// Repository config is writable by the agent, so it must not choose programs or index writes:
// core.fsmonitor runs a program, status refreshes .git/index unless optional locks are off, and diff
// refreshes it regardless of that flag unless diff.autoRefreshIndex is false.
const READ_ONLY_GIT = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false'];

function runGit(workspace, args) {
  const result = spawnSync('git', [...READ_ONLY_GIT, ...args], {
    cwd: workspace,
    env: cleanGitEnvironment(),
    encoding: 'buffer',
    maxBuffer: MAX_RESULT_BYTES
  });
  if (result.error) throw new Error('git inspection failed');
  if (result.status !== 0) throw new Error('git inspection returned a non-zero status');
  return boundedText(result.stdout);
}

// status and diff run the clean/process command of any filter driver named in .gitattributes. Only
// the commands written by `git lfs install` (with or without --skip-smudge) are trusted.
const GIT_LFS_FILTER_COMMANDS = {
  'filter.lfs.clean': ['git-lfs clean -- %f'],
  'filter.lfs.smudge': ['git-lfs smudge -- %f', 'git-lfs smudge --skip -- %f'],
  'filter.lfs.process': ['git-lfs filter-process', 'git-lfs filter-process --skip']
};

function refuseUntrustedFilters(workspace) {
  // Reading configuration runs no configured program; exit 1 means no key matched.
  const result = spawnSync('git', [...READ_ONLY_GIT, 'config', '--null', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], {
    cwd: workspace,
    env: cleanGitEnvironment(),
    encoding: 'utf8',
    maxBuffer: MAX_RESULT_BYTES
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error('git filter configuration could not be read');
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    const [key, value = ''] = entry.split(/\n(.*)/s);
    if (!GIT_LFS_FILTER_COMMANDS[key]?.includes(value)) throw new Error(`git filter driver ${key} is not the standard Git LFS command; status and diff would run it`);
  }
}

async function fetchAllowlisted(profile, input) {
  if (typeof input.url !== 'string' || input.url.length > 2048) throw new Error('url must be a bounded string');
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.username || url.password || !profile.allowHosts.includes(url.hostname)) throw new Error('url is outside the HTTPS host allowlist');
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (response.status >= 300 && response.status < 400) throw new Error('redirects are refused to preserve the egress allowlist');
  if (!response.ok) throw new Error(`allowlisted fetch returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESULT_BYTES) throw new Error('response exceeds the result budget');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESULT_BYTES) { await reader.cancel(); throw new Error('response exceeds the result budget'); }
    chunks.push(value);
  }
  return boundedText(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

// A diff never shows a path isSensitiveWorkspacePath classifies sensitive, in either mode. The changed
// paths are listed first with the same options and each sensitive one is excluded by its exact name;
// renames are off, so both sides of a rename are separate paths. Every file header of the result is
// checked again, and the call is refused when a header cannot be read or names a sensitive path.
const DIFF_MAX_EXCLUDED_PATHS = 1000;
function gitDiff(workspace, input) {
  const base = ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
  if (input.staged === true) base.push('--cached');
  const scope = input.path === undefined ? [] : [safeRelative(input.path)];
  const changed = runGit(workspace, [...base, '--name-only', '-z', '--', ...scope]).split('\0').filter(Boolean);
  const sensitive = changed.filter((file) => isSensitiveWorkspacePath(file));
  if (sensitive.length > DIFF_MAX_EXCLUDED_PATHS) throw new Error('the diff touches too many protected credential files to exclude safely');
  const text = runGit(workspace, [...base, '--', ...scope, ...sensitive.map((file) => `:(exclude,literal)${file}`)]);
  for (const line of text.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    // Without renames both sides name one path: `a/P b/P`.
    const sides = line.slice('diff --git '.length);
    const file = sides.length % 2 === 1 ? sides.slice(2, 2 + (sides.length - 5) / 2) : null;
    if (file === null || sides !== `a/${file} b/${file}` || isSensitiveWorkspacePath(file)) {
      throw new Error('the diff would include a protected credential file');
    }
  }
  return text;
}

async function callTool(profile, workspace, name, input) {
  if (!MODES[profile.mode].has(name) || !input || Array.isArray(input) || typeof input !== 'object') throw new Error('tool call is outside the profile contract');
  if (name === 'read_file') {
    const { resolved, metadata } = existingWorkspacePath(workspace, input.path);
    const maxBytes = input.maxBytes === undefined ? 128 * 1024 : input.maxBytes;
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 || metadata.size > maxBytes) throw new Error('file exceeds the declared read budget');
    return boundedText(readFileSync(resolved), maxBytes);
  }
  if (name === 'list_directory') {
    const { resolved } = existingWorkspacePath(workspace, input.path || '.', { directory: true });
    return readdirSync(resolved, { withFileTypes: true })
      .filter((entry) => !isPrivateDirectory(entry.name) && !isSensitiveWorkspacePath(path.relative(workspace, path.join(resolved, entry.name))))
      .slice(0, 500)
      .map((entry) => `${entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'}\t${entry.name}`)
      .join('\n');
  }
  if (name === 'search_files') {
    if (typeof input.query !== 'string' || input.query.length < 1 || input.query.length > 200) throw new Error('query must contain 1-200 characters');
    const { resolved } = existingWorkspacePath(workspace, input.path || '.', { directory: true });
    return walk(resolved, workspace).filter((file) => file.includes(input.query)).slice(0, 200).join('\n');
  }
  if (name === 'git_status' || name === 'git_diff') refuseUntrustedFilters(workspace);
  if (name === 'git_status') return runGit(workspace, ['status', '--short', '--branch', '--untracked-files=normal']);
  if (name === 'git_diff') return gitDiff(workspace, input);
  if (name === 'git_log') {
    const limit = input.limit === undefined ? 20 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100');
    return runGit(workspace, ['log', '--no-show-signature', `--max-count=${limit}`, '--format=%H%x09%aI%x09%s']);
  }
  if (name === 'fetch_url') return fetchAllowlisted(profile, input);
  throw new Error('unknown tool');
}

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function errorResponse(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

export async function handleMessage(state, message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new Error('invalid JSON-RPC request');
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'initialize') {
    return response(message.id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(message.params?.protocolVersion)
        ? message.params.protocolVersion
        : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: state.profile.serverName, version: '1.0.0' }
    });
  }
  if (message.method === 'tools/list') return response(message.id, { tools: state.profile.tools });
  if (message.method === 'tools/call') {
    try {
      const text = await callTool(state.profile, state.workspace, message.params?.name, message.params?.arguments || {});
      return response(message.id, { content: [{ type: 'text', text }] });
    } catch (error) {
      return response(message.id, { content: [{ type: 'text', text: `Refused: ${error.message}` }], isError: true });
    }
  }
  if (message.id !== undefined) errorResponse(message.id, -32601, 'Method not found');
}

async function main() {
  const index = process.argv.indexOf('--profile');
  if (index < 0 || !process.argv[index + 1]) throw new Error('usage: readonly-mcp-server.mjs --profile <relative-profile>');
  const state = readProfile(process.argv[index + 1]);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) { errorResponse(null, -32600, 'Request exceeds the message budget'); continue; }
    let message;
    try { message = JSON.parse(line); } catch { errorResponse(null, -32700, 'Parse error'); continue; }
    try { await handleMessage(state, message); }
    catch { errorResponse(message?.id ?? null, -32600, 'Invalid request'); }
  }
}

function canonicalIfPresent(file) {
  try { return realpathSync(file); } catch { return ''; }
}

const invoked = process.argv[1] ? canonicalIfPresent(process.argv[1]) : '';
if (invoked && invoked === canonicalIfPresent(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`readonly MCP server refused startup: ${error.message}\n`);
    process.exitCode = 1;
  });
}
