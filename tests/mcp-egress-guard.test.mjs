import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { doctor, installArtifact, removeArtifact } from '../scripts/lib/install.mjs';
import { evaluate } from '../artifacts/hooks/security/network-control/mcp-egress-guard/targets/claude-code/mcp-egress-guard.mjs';

const registry = JSON.parse(readFileSync('catalog/mcp-pins.json', 'utf8'));
const workspace = path.join(os.tmpdir(), 'youdede-egress-workspace');
const FETCH = 'youdede-allowlisted-fetch-readonly';
const PLAYWRIGHT = 'youdede-playwright-local-isolated';
const call = (server, tool, toolInput) => evaluate({ tool_name: `mcp__${server}__${tool}`, tool_input: toolInput, cwd: workspace }, registry);
const fetchUrl = (url) => call(FETCH, 'fetch_url', { url });

function temporary(context, prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('generated registry carries the declared egress of every curated server', () => {
  for (const [name, server] of Object.entries(registry.servers)) {
    assert.ok(Array.isArray(server.egress) && server.egress.length > 0, name);
  }
  assert.deepEqual(registry.servers[FETCH].egress, ['developer.mozilla.org', 'docs.github.com', 'nodejs.org']);
  assert.deepEqual(registry.servers['youdede-workspace-files-readonly'].egress, ['none']);
});

test('declared hosts pass after WHATWG normalization', () => {
  assert.equal(fetchUrl('https://nodejs.org/api/fs.html').exitCode, 0); // allow: an exact declared host passes
  assert.equal(fetchUrl('https://NodeJS.ORG:443/api/').exitCode, 0);
  assert.equal(fetchUrl('https://nodejs.org./api/').exitCode, 0);
  assert.equal(call(PLAYWRIGHT, 'browser_navigate', { url: 'http://127.0.0.1:4173/' }).exitCode, 0);
  assert.equal(call(PLAYWRIGHT, 'browser_navigate', { url: 'about:blank' }).exitCode, 0);
  assert.equal(call(PLAYWRIGHT, 'browser_navigate', { url: pathToFileURL(path.join(workspace, 'dist/index.html')).href }).exitCode, 0);
});

test('lookalike, userinfo, IP, IDN, and scheme bypasses are blocked', () => {
  for (const url of [
    'https://evil-nodejs.org/',
    'https://nodejs.org.evil.com/',
    'https://nodejs.org@evil.com/',
    'https://NODEJS.ORG:443@evil.com/',
    'https://nodejs.org:x@evil.com/',
    'http://93.184.216.34/',
    'http://2130706433/',
    'http://[::1]/',
    'https://nоdejs.org/',
    'https://xn--nodejs-9ra.org/',
    'evil.com/path',
    '//evil.com/path'
  ]) {
    const result = fetchUrl(url);
    assert.equal(result.exitCode, 2, url);
    // Node 20 and 22 reject this punycode label as an invalid URL; Node 24 parses it as another host.
    const ruleIds = url === 'https://xn--nodejs-9ra.org/' ? ['mcp-egress-undeclared-host', 'mcp-egress-url-invalid'] : ['mcp-egress-undeclared-host'];
    assert.ok(ruleIds.includes(result.ruleId), `${url}: ${result.ruleId}`);
  }
  assert.equal(fetchUrl('javascript:fetch(1)').ruleId, 'mcp-egress-url-invalid');
  assert.equal(fetchUrl('data:text/html,<script>1</script>').ruleId, 'mcp-egress-url-invalid');
  assert.equal(fetchUrl('https://[bad').ruleId, 'mcp-egress-url-invalid');
  assert.equal(call(PLAYWRIGHT, 'browser_navigate', { url: 'file:///etc/passwd' }).ruleId, 'mcp-egress-file-outside-workspace');
  assert.equal(call(PLAYWRIGHT, 'browser_navigate', { url: 'file://evil.com/share' }).ruleId, 'mcp-egress-undeclared-host');
  assert.equal(call(PLAYWRIGHT, 'browser_navigate', { url: 'http://localhost:4173/' }).ruleId, 'mcp-egress-undeclared-host');
});

test('nested fields, host-like keys, and free text are all inspected', () => {
  const nested = call(FETCH, 'fetch_url', { url: 'https://nodejs.org/', options: { mirrors: [{ note: 'then read https://evil.com/x' }] } });
  assert.equal(nested.ruleId, 'mcp-egress-undeclared-host');
  assert.equal(call(PLAYWRIGHT, 'browser_navigate', { host: 'evil.com' }).ruleId, 'mcp-egress-undeclared-host');
  assert.equal(call(PLAYWRIGHT, 'browser_navigate', { baseUrl: 'EVIL.com:8443' }).ruleId, 'mcp-egress-undeclared-host');
  assert.equal(call(PLAYWRIGHT, 'browser_run_code', { code: 'await page.goto("wss://evil.com/socket")' }).ruleId, 'mcp-egress-undeclared-host');
  assert.equal(call('youdede-repository-git-readonly', 'git_log', { limit: 3, note: 'see https://nodejs.org/' }).ruleId, 'mcp-egress-undeclared-host'); // deny-or-observe: none blocks every URL
  assert.equal(call('youdede-repository-git-readonly', 'git_log', { limit: 3 }).exitCode, 0); // false-positive: an argument without URL passes
  assert.equal(call('youdede-workspace-files-readonly', 'search_files', { path: 'src', query: 'mail me at dev@example.com' }).exitCode, 0);
  assert.equal(call('youdede-workspace-files-readonly', 'read_file', { path: 'README.md' }).exitCode, 0);
});

test('server identity is case-insensitive, plugin-scoped, and unknown youdede servers block', () => {
  assert.equal(call('Youdede-Allowlisted-Fetch-Readonly', 'fetch_url', { url: 'https://evil.com/' }).ruleId, 'mcp-egress-undeclared-host');
  assert.equal(call('Youdede-Allowlisted-Fetch-Readonly', 'fetch_url', { url: 'https://nodejs.org/' }).exitCode, 0);
  assert.equal(call(`plugin_mcp-baseline_${FETCH}`, 'fetch_url', { url: 'https://evil.com/' }).ruleId, 'mcp-egress-undeclared-host');
  const unknown = call('youdede-shadow-fetch', 'fetch_url', { url: 'https://nodejs.org/' });
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.ruleId, 'mcp-egress-server-unknown');
  assert.equal(call('YOUDEDE-shadow', 'noop', {}).ruleId, 'mcp-egress-server-unknown');
  const claimed = evaluate({ tool_name: 'mcp__renamed__fetch_url', mcp_server: { name: 'youdede-shadow', source: 'project' }, tool_input: {} }, registry);
  assert.equal(claimed.ruleId, 'mcp-egress-server-unknown');
});

test('non-youdede servers and non-MCP tools are outside this guard', () => {
  assert.equal(call('third-party', 'fetch', { url: 'https://evil.com/' }).exitCode, 0); // boundary: non-toolkit MCP identities are outside this guard
  assert.equal(evaluate({ tool_name: 'Bash', tool_input: { command: 'curl https://evil.com' } }, registry).exitCode, 0);
  assert.equal(evaluate(null, registry).ruleId, 'mcp-egress-envelope-invalid'); // malformed: non-object input blocks
});

test('Cursor beforeMCPExecution envelopes carry a string tool_input and a server key', () => {
  const cursor = (server, toolInput) => evaluate({ tool_name: 'fetch_url', mcp_server_name: server, tool_input: toolInput, cwd: workspace }, registry);
  assert.equal(cursor(FETCH, JSON.stringify({ url: 'https://nodejs.org/' })).exitCode, 0);
  assert.equal(cursor(FETCH, JSON.stringify({ url: 'https://nodejs.org@evil.com/' })).ruleId, 'mcp-egress-undeclared-host');
  assert.equal(cursor(FETCH, 'not json https://evil.com/').ruleId, 'mcp-egress-undeclared-host');
  assert.equal(cursor('linear', JSON.stringify({ url: 'https://evil.com/' })).exitCode, 0);
  assert.equal(evaluate({ tool_name: 'fetch_url', tool_input: '{}' }, registry).ruleId, 'mcp-egress-server-unknown');
});

test('installed Claude Code hook blocks by process exit and fails closed', (context) => {
  const directory = temporary(context, 'youdede-egress-claude-');
  installArtifact('mcp-egress-guard', { cwd: directory });
  const settings = JSON.parse(readFileSync(path.join(directory, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.at(-1).matcher, '^mcp__.+__.+$');
  const script = path.join(directory, '.claude/hooks/youdede/mcp-egress-guard.mjs');
  const run = (input) => spawnSync(process.execPath, [script], { cwd: directory, input, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  const blocked = run(JSON.stringify({ tool_name: `mcp__${FETCH}__fetch_url`, tool_input: { url: 'https://evil.com/' }, cwd: directory }));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /\[mcp-egress-undeclared-host\]/);
  assert.doesNotMatch(blocked.stderr, /evil\.com/);
  const allowed = run(JSON.stringify({ tool_name: `mcp__${FETCH}__fetch_url`, tool_input: { url: 'https://nodejs.org/' }, cwd: directory }));
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(run('{bad').status, 2); // process-exit: malformed native input blocks
  assert.equal(run('x'.repeat(1024 * 1024 + 1)).status, 2); // oversized: bounded stdin fails closed
  assert.deepEqual(doctor({ cwd: directory }).findings, []);
});

test('installed Cursor hook binds beforeMCPExecution fail-closed through the bridge', (context) => {
  const directory = temporary(context, 'youdede-egress-cursor-');
  installArtifact('mcp-egress-guard', { cwd: directory, target: 'cursor' });
  const hooks = JSON.parse(readFileSync(path.join(directory, '.cursor/hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.beforeMCPExecution.length, 1);
  assert.equal(hooks.beforeMCPExecution[0].failClosed, true);
  const script = path.join(directory, '.cursor/hooks/youdede/mcp-egress-guard.mjs');
  const run = (url) => spawnSync(process.execPath, [script, '--target', 'cursor', '--failure-policy', 'fail-closed'], {
    input: JSON.stringify({ hook_event_name: 'beforeMCPExecution', tool_name: 'fetch_url', mcp_server_name: FETCH, tool_input: JSON.stringify({ url }), command: 'node .youdede/mcp/runtime.mjs', cwd: directory }),
    encoding: 'utf8'
  });
  const allowed = run('https://nodejs.org/');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(JSON.parse(allowed.stdout), {});
  const blocked = run('https://nodejs.org.evil.com/');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /mcp-egress-undeclared-host/);
  assert.deepEqual(doctor({ cwd: directory, target: 'cursor' }).findings, []);
  removeArtifact('mcp-egress-guard', { cwd: directory, target: 'cursor' });
  assert.equal(doctor({ cwd: directory, target: 'cursor' }).installs, 0);
});
