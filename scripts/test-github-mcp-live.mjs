#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = JSON.parse(readFileSync(path.join(ROOT, 'artifacts/mcp-servers/development/agent-tooling/github-readonly/server.json'), 'utf8'));
const expectedTools = [
  'actions_get', 'actions_list', 'get_commit', 'get_file_contents', 'get_job_logs',
  'get_label', 'get_latest_release', 'get_release_by_tag', 'get_tag', 'issue_read',
  'list_branches', 'list_commits', 'list_issue_fields', 'list_issue_types',
  'list_issues', 'list_pull_requests', 'list_releases', 'list_repository_collaborators',
  'list_tags', 'pull_request_read', 'search_code', 'search_commits', 'search_issues',
  'search_pull_requests', 'search_repositories'
];
const rejectedMutations = ['create_issue', 'merge_pull_request', 'create_or_update_file', 'cancel_workflow_run'];

async function testLiveServer() {
  const authenticatedRead = process.argv.includes('--authenticated-read');
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  if (authenticatedRead) {
    assert.ok(process.env.GITHUB_PERSONAL_ACCESS_TOKEN, 'Authenticated read requires GITHUB_PERSONAL_ACCESS_TOKEN');
    assert.ok(owner && repo && process.env.GITHUB_SHA, 'Authenticated read requires GITHUB_REPOSITORY and GITHUB_SHA');
  }
  assert.equal(profile.launch.command, 'docker');
  assert.ok(profile.launch.args.includes('--read-only'));
  assert.ok(profile.launch.args.includes('repos,pull_requests,issues,actions'));
  assert.ok(profile.launch.args.includes(`${profile.provider.package}@${profile.provider.digest}`));

  // Discovery uses a fake token even when a real credential exists in the environment.
  const child = spawn(profile.launch.command, profile.launch.args, {
    cwd: ROOT,
    env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: authenticatedRead ? process.env.GITHUB_PERSONAL_ACCESS_TOKEN : 'invalid-youdede-live-test-token' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => {
    stderr.push(chunk.toString());
    if (stderr.length > 20) stderr.shift();
  });

  let nextId = 1;
  const pending = new Map();
  const send = (method, params = {}) => {
    const id = nextId++;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };
  const failPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.stdin.on('error', failPending);
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const waiting = pending.get(message.id);
      if (waiting) {
        pending.delete(message.id);
        waiting.resolve(message);
      }
    } catch (error) {
      failPending(error);
    }
  });
  child.on('error', failPending);
  const diagnostic = () => authenticatedRead ? 'server stderr omitted because a live token was supplied' : stderr.join('').slice(-1000);
  child.on('close', (code) => failPending(new Error(`GitHub MCP exited ${code}: ${diagnostic()}`)));
  const timeout = setTimeout(() => {
    failPending(new Error(`GitHub MCP did not respond within 120 seconds: ${diagnostic()}`));
    child.kill();
  }, 120_000);

  try {
    const initialized = await send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'youdede-live-test', version: '1.0.0' }
    });
    assert.equal(initialized.result?.protocolVersion, '2025-03-26', JSON.stringify(initialized.error));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const listed = await send('tools/list');
    assert.equal(listed.error, undefined, JSON.stringify(listed.error));
    assert.equal(listed.result?.nextCursor, undefined, 'The test must inspect the complete inventory');
    const tools = listed.result?.tools;
    assert.ok(Array.isArray(tools));
    assert.deepEqual(tools.map(({ name }) => name).sort(), expectedTools);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} lacks readOnlyHint`);
      assert.ok(tool.description?.trim(), `${tool.name} lacks a description`);
    }

    if (!authenticatedRead) {
      for (const name of rejectedMutations) {
        const response = await send('tools/call', { name, arguments: {} });
        assert.equal(response.error?.code, -32602, `${name} was not rejected as an unknown tool`);
        assert.match(response.error.message, /unknown tool/i);
      }
    }
    if (authenticatedRead) {
      const response = await send('tools/call', {
        name: 'get_file_contents',
        arguments: { owner, repo, path: 'package.json', sha: process.env.GITHUB_SHA }
      });
      assert.equal(response.error, undefined, 'Authenticated GitHub read returned a protocol error');
      assert.notEqual(response.result?.isError, true, 'Authenticated GitHub read failed');
      assert.ok(response.result?.content?.some(({ type, text }) => type === 'text' && text?.trim()), 'Authenticated GitHub read returned no file content');
    }
    process.stdout.write(`Verified live GitHub MCP: ${tools.length} read-only tools; ${authenticatedRead ? 'authenticated package.json read succeeded' : `${rejectedMutations.length} mutation calls rejected`}.\n`);
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
  }
}

testLiveServer().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
