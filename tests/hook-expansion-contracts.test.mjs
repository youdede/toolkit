import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as h0 from '../artifacts/hooks/data/compatibility/schema-compatibility-guard/targets/claude-code/schema-compatibility-guard.mjs';
import * as h1 from '../artifacts/hooks/development/contract-compatibility/api-contract-compatibility-guard/targets/claude-code/api-contract-compatibility-guard.mjs';
import * as h2 from '../artifacts/hooks/security/deserialization/unsafe-deserialization-guard/targets/claude-code/unsafe-deserialization-guard.mjs';
import * as h3 from '../artifacts/hooks/development/diagnostic-suppression/lint-suppression-guard/targets/claude-code/lint-suppression-guard.mjs';
import * as h4 from '../artifacts/hooks/development/error-handling/exception-swallowing-guard/targets/claude-code/exception-swallowing-guard.mjs';
import * as h5 from '../artifacts/hooks/development/assertion-integrity/test-assertion-removal-guard/targets/claude-code/test-assertion-removal-guard.mjs';
import * as h6 from '../artifacts/hooks/development/binary-integrity/binary-mutation-guard/targets/claude-code/binary-mutation-guard.mjs';
import * as h7 from '../artifacts/hooks/design/semantic-markup/accessibility-attribute-regression-guard/targets/claude-code/accessibility-attribute-regression-guard.mjs';
import * as h8 from '../artifacts/hooks/design/keyboard-focus/focus-style-regression-guard/targets/claude-code/focus-style-regression-guard.mjs';
import * as h9 from '../artifacts/hooks/data/live-query-safety/database-query-mode-guard/targets/claude-code/database-query-mode-guard.mjs';
import * as h10 from '../artifacts/hooks/operations/delegation-budget/subagent-fanout-guard/targets/claude-code/subagent-fanout-guard.mjs';
import * as h11 from '../artifacts/hooks/operations/process-lifecycle/foreground-process-guard/targets/claude-code/foreground-process-guard.mjs';

const scripts = {
  'schema-compatibility-guard': path.resolve('artifacts/hooks/data/compatibility/schema-compatibility-guard/targets/claude-code/schema-compatibility-guard.mjs'),
  'api-contract-compatibility-guard': path.resolve('artifacts/hooks/development/contract-compatibility/api-contract-compatibility-guard/targets/claude-code/api-contract-compatibility-guard.mjs'),
  'unsafe-deserialization-guard': path.resolve('artifacts/hooks/security/deserialization/unsafe-deserialization-guard/targets/claude-code/unsafe-deserialization-guard.mjs'),
  'lint-suppression-guard': path.resolve('artifacts/hooks/development/diagnostic-suppression/lint-suppression-guard/targets/claude-code/lint-suppression-guard.mjs'),
  'exception-swallowing-guard': path.resolve('artifacts/hooks/development/error-handling/exception-swallowing-guard/targets/claude-code/exception-swallowing-guard.mjs'),
  'test-assertion-removal-guard': path.resolve('artifacts/hooks/development/assertion-integrity/test-assertion-removal-guard/targets/claude-code/test-assertion-removal-guard.mjs'),
  'binary-mutation-guard': path.resolve('artifacts/hooks/development/binary-integrity/binary-mutation-guard/targets/claude-code/binary-mutation-guard.mjs'),
  'accessibility-attribute-regression-guard': path.resolve('artifacts/hooks/design/semantic-markup/accessibility-attribute-regression-guard/targets/claude-code/accessibility-attribute-regression-guard.mjs'),
  'focus-style-regression-guard': path.resolve('artifacts/hooks/design/keyboard-focus/focus-style-regression-guard/targets/claude-code/focus-style-regression-guard.mjs'),
  'database-query-mode-guard': path.resolve('artifacts/hooks/data/live-query-safety/database-query-mode-guard/targets/claude-code/database-query-mode-guard.mjs'),
  'subagent-fanout-guard': path.resolve('artifacts/hooks/operations/delegation-budget/subagent-fanout-guard/targets/claude-code/subagent-fanout-guard.mjs'),
  'foreground-process-guard': path.resolve('artifacts/hooks/operations/process-lifecycle/foreground-process-guard/targets/claude-code/foreground-process-guard.mjs')
};
const writeInput = (file) => ({ tool_name: 'Write', tool_input: { file_path: file } });
const runHook = (slug, input) => spawnSync(process.execPath, [scripts[slug]], { input: JSON.stringify(input), encoding: 'utf8' });

test('contract and orchestration guards own distinct deterministic boundaries', () => {
  const decisions = [
    [h0, writeInput('event.schema.json'), { file: 'event.schema.json', before: '{"type":"object","properties":{"user":{"type":"object","properties":{"id":{"type":"string"}}}}}', proposed: '{"type":"object","properties":{"user":{"type":"object","properties":{}}}}', complete: true }, 'schema-breaking-change'],
    [h1, writeInput('openapi.json'), { file: 'openapi.json', before: '{"paths":{"/users":{"get":{"responses":{"200":{}}}}}}', proposed: '{"paths":{}}', complete: true }, 'api-contract-element-removed'],
    [h2, writeInput('load.py'), { file: 'load.py', before: 'import pickle as p', proposed: 'import pickle as p\nreturn p.loads(data)', complete: true }, 'unsafe-deserialization-api-added'],
    [h3, writeInput('app.ts'), { file: 'app.ts', before: 'const x=1', proposed: '// @ts-nocheck\nconst x=1', complete: true }, 'broad-lint-suppression-added'],
    [h4, writeInput('app.js'), { file: 'app.js', before: 'work()', proposed: 'try { work() } catch {}', complete: true }, 'exception-swallowing-added'],
    [h5, writeInput('tests/app.test.js'), { file: 'tests/app.test.js', before: 'test("x",()=>expect(x).toBe(1))\ntest("y",()=>expect(y).toBe(2))', proposed: 'test("x",()=>x)\ntest("y",()=>expect(y).toBe(2))', complete: true }, 'last-test-assertion-removed'],
    [h6, writeInput('image'), { file: 'image', existing: true, prefix: Buffer.from('ffd8ffe000000000', 'hex') }, 'binary-text-mutation'],
    [h7, writeInput('view.tsx'), { file: 'view.tsx', before: '<img id="avatar" alt="avatar" src={x}/><img id="logo" alt="logo"/>', proposed: '<img id="avatar" src={x}/><img id="logo" alt="logo" aria-label="extra"/>', complete: true }, 'accessibility-relationship-removed'],
    [h8, writeInput('app.css'), { file: 'app.css', before: '.a:focus{outline:2px solid blue}.b:focus{outline:2px solid blue}', proposed: '.a:focus{outline:none}.b:focus{outline:2px solid blue;box-shadow:0 0 0 2px blue}', complete: true }, 'focus-indicator-removed'],
    [h9, { tool_name: 'Bash', tool_input: { command: 'psql --command="DELETE FROM users"' } }, {}, 'live-database-write'],
    [h10, { tool_name: 'Task' }, { priorDelegations: 8 }, 'subagent-budget-exhausted'],
    [h11, { tool_name: 'Bash', tool_input: { command: 'timeout 1 true; npm --prefix web run dev' } }, {}, 'indefinite-foreground-process']
  ];
  for (const [module, input, context, ruleId] of decisions) { const result = module.evaluate(input, context); assert.equal(result.exitCode, 2, ruleId); assert.equal(result.ruleId, ruleId); }
});

test('reported false positives remain allowed without weakening the boundary', () => {
  const allowed = [
    [h0, writeInput('config.json'), { file: 'config.json', before: '{"type":"object","properties":{"id":{"type":"string"}}}', proposed: '{"type":"object","properties":{}}', complete: true }],
    [h0, writeInput('event.schema.json'), { file: 'event.schema.json', before: '{"type":["string","null"]}', proposed: '{"type":["null","number","string"]}', complete: true }],
    [h0, writeInput('event.proto'), { file: 'event.proto', before: 'message A { string name = 1; }\nmessage B { int32 count = 1; }', proposed: 'message A { string name = 1; }\nmessage B { int32 count = 1; }', complete: true }],
    [h1, writeInput('openapi.json'), { file: 'openapi.json', before: '{"paths":{"/x":{"get":{"parameters":[{"in":"query","name":"q","required":true}],"responses":{"200":{}}}}}}', proposed: '{"paths":{"/x":{"get":{"parameters":[{"in":"query","name":"q","required":false}],"responses":{"200":{}}}}}}', complete: true }],
    [h1, writeInput('openapi.json'), { file: 'openapi.json', before: '', proposed: '{"openapi":"3.1.0","paths":{}}', complete: true }],
    [h2, writeInput('safe.py'), { file: 'safe.py', before: '', proposed: 'import yaml\nyaml.safe_load(data)', complete: true }],
    [h3, writeInput('app.ts'), { file: 'app.ts', before: '', proposed: '// eslint-disable-next-line no-console', complete: true }],
    [h4, writeInput('app.js'), { file: 'app.js', before: '', proposed: 'try{x()}catch(e){throw e}', complete: true }],
    [h5, writeInput('tests/app.test.js'), { file: 'tests/app.test.js', before: 'test("x",()=>expect(x).toBe(1))', proposed: 'test("x",()=>assert.equal(x,1))', complete: true }],
    [h6, writeInput('notes.txt'), { file: 'notes.txt', existing: true, prefix: Buffer.from('plain text') }],
    [h7, writeInput('view.tsx'), { file: 'view.tsx', before: '<button id="save" role="button">Save</button>', proposed: '<button id="save">Save</button>', complete: true }],
    [h8, writeInput('app.css'), { file: 'app.css', before: '', proposed: '.x:focus{outline:none;box-shadow:0 0 0 2px blue}', complete: true }],
    [h9, { tool_name: 'mcp__search__query', tool_input: { query: 'delete old records' } }, {}],
    [h9, { tool_name: 'Bash', tool_input: { command: 'mysql -e "SELECT `DELETE` FROM audit"' } }, {}],
    [h10, { tool_name: 'Task' }, { priorDelegations: 2 }],
    [h11, { tool_name: 'Bash', tool_input: { command: 'timeout 30 npm run dev' } }, {}],
    [h11, { tool_name: 'Bash', tool_input: { command: 'npm run dev & echo ready' } }, {}]
  ];
  for (const [module, input, context] of allowed) assert.equal(module.evaluate(input, context).exitCode, 0, JSON.stringify(input));
});

test('specific bypass forms are rejected', () => {
  const cases = [
    [h0, writeInput('event.proto'), { file: 'event.proto', before: 'message A { string value = 1; }\nmessage B { int32 value = 1; }', proposed: 'message A { int32 value = 1; }\nmessage B { int32 value = 1; }', complete: true }, 'protobuf-field-identity-changed'],
    [h1, writeInput('spec/api.yaml'), { file: 'spec/api.yaml', before: 'openapi: 3.1.0\npaths:\n  /users:\n    get:\n      parameters:\n        - name: limit\n          in: query\n          required: false\n      responses:\n        "200": {}', proposed: 'openapi: 3.1.0\npaths:\n  /users:\n    get:\n      parameters:\n        - name: limit\n          in: query\n          required: true\n      responses:\n        "200": {}', complete: true }, 'api-required-input-added'],
    [h3, writeInput('app.js'), { file: 'app.js', before: '', proposed: '// eslint-disable-next-line\nwork()', complete: true }, 'broad-lint-suppression-added'],
    [h3, writeInput('app.py'), { file: 'app.py', before: '', proposed: 'work()  # noqa\n', complete: true }, 'broad-lint-suppression-added'],
    [h4, writeInput('app.js'), { file: 'app.js', before: '', proposed: 'promise.catch(function () {})', complete: true }, 'exception-swallowing-added'],
    [h9, { tool_name: 'Bash', tool_input: { command: 'printf "DELETE FROM users" | psql app' } }, {}, 'database-query-uninspectable'],
    [h9, { tool_name: 'PowerShell', tool_input: { command: 'Invoke-Sqlcmd -Query "DELETE FROM users"' } }, {}, 'live-database-write'],
    [h11, { tool_name: 'Bash', tool_input: { command: 'npm run dev; echo --help' } }, {}, 'indefinite-foreground-process'],
    [h11, { tool_name: 'Bash', tool_input: { command: 'npm run dev; echo done &' } }, {}, 'indefinite-foreground-process'],
    [h11, { tool_name: 'Bash', tool_input: { command: 'vite' } }, {}, 'indefinite-foreground-process']
  ];
  for (const [module, input, context, ruleId] of cases) assert.equal(module.evaluate(input, context).ruleId, ruleId);
});

test('file collectors reject ancestor-symlink escapes', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'youdede-hook-root-')); const outside = mkdtempSync(path.join(tmpdir(), 'youdede-hook-outside-')); t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(path.join(outside, 'target.ts'), 'const value = 1'); symlinkSync(outside, path.join(root, 'alias'));
  for (const module of [h0, h1, h2, h3, h4, h5, h7, h8]) {
    const context = module.collectContext({ tool_name: 'Write', cwd: root, tool_input: { file_path: 'alias/target.ts', content: 'changed' } }, root);
    assert.equal(context.complete, false); assert.equal(context.inspectionError, 'path-alias-escape');
  }
  const binary = h6.collectContext({ tool_name: 'Write', cwd: root, tool_input: { file_path: 'alias/target.ts', content: 'changed' } }, root);
  assert.equal(binary.inspectionError, 'path-alias-escape');
});

test('subagent collector counts structural calls, ignores metadata, and deduplicates IDs', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'youdede-transcript-')); t.after(() => rmSync(root, { recursive: true, force: true })); const transcript = path.join(root, 'session.jsonl');
  const events = [{ type: 'metadata', name: 'Task' }, ...Array.from({ length: 8 }, (_, index) => ({ type: 'tool_use', name: 'Task', id: 'call-' + index })), { type: 'tool_use', name: 'Task', id: 'call-0' }];
  writeFileSync(transcript, events.map((event) => JSON.stringify(event)).join('\n'));
  const context = h10.collectContext({ tool_name: 'Task', transcript_path: transcript }); assert.equal(context.priorDelegations, 8); assert.equal(h10.evaluate({ tool_name: 'Task' }, context).ruleId, 'subagent-budget-exhausted');
});

test('reported bypasses are exercised through the installed hook processes', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'youdede-hook-e2e-')); t.after(() => rmSync(root, { recursive: true, force: true })); const put = (file, content) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); };
  const cases = [];
  put('event.schema.json', '{"type":"object","properties":{"nested":{"type":"object","properties":{"id":{"type":"string"}}}}}'); cases.push(['schema-compatibility-guard', { tool_name: 'Write', cwd: root, tool_input: { file_path: 'event.schema.json', content: '{"type":"object","properties":{"nested":{"type":"object","properties":{}}}}' } }]);
  put('spec/api.yaml', 'openapi: 3.1.0\npaths:\n  /x:\n    get:\n      parameters:\n        - name: q\n          in: query\n          required: false\n      responses:\n        "200": {}'); cases.push(['api-contract-compatibility-guard', { tool_name: 'Write', cwd: root, tool_input: { file_path: 'spec/api.yaml', content: 'openapi: 3.1.0\npaths:\n  /x:\n    get:\n      parameters:\n        - name: q\n          in: query\n          required: true\n      responses:\n        "200": {}' } }]);
  put('load.py', 'import pickle as p\n'); cases.push(['unsafe-deserialization-guard', { tool_name: 'Write', cwd: root, tool_input: { file_path: 'load.py', content: 'import pickle as p\np.loads(blob)\n' } }]);
  put('app.ts', 'work()\n'); cases.push(['lint-suppression-guard', { tool_name: 'Write', cwd: root, tool_input: { file_path: 'app.ts', content: '// @ts-nocheck\nwork()\n' } }]);
  put('errors.js', 'work()\n'); cases.push(['exception-swallowing-guard', { tool_name: 'Write', cwd: root, tool_input: { file_path: 'errors.js', content: 'try { work() } catch {}\n' } }]);
  put('tests/app.test.js', 'test("x",()=>expect(x).toBe(1))\ntest("y",()=>expect(y).toBe(2))'); cases.push(['test-assertion-removal-guard', { tool_name: 'Write', cwd: root, tool_input: { file_path: 'tests/app.test.js', content: 'test("x",()=>x)\ntest("y",()=>expect(y).toBe(2))' } }]);
  put('asset', Buffer.from('ffd8ffe000000000', 'hex')); cases.push(['binary-mutation-guard', { tool_name: 'Write', cwd: root, tool_input: { file_path: 'asset', content: 'not binary' } }]);
  put('view.tsx', '<img id="avatar" alt="avatar"/><img id="logo" alt="logo"/>'); cases.push(['accessibility-attribute-regression-guard', { tool_name: 'Write', cwd: root, tool_input: { file_path: 'view.tsx', content: '<img id="avatar"/><img id="logo" alt="logo" aria-label="extra"/>' } }]);
  put('app.css', '.a:focus{outline:2px solid blue}.b:focus{outline:2px solid blue}'); cases.push(['focus-style-regression-guard', { tool_name: 'Write', cwd: root, tool_input: { file_path: 'app.css', content: '.a:focus{outline:none}.b:focus{outline:2px solid blue;box-shadow:0 0 0 2px blue}' } }]);
  cases.push(['database-query-mode-guard', { tool_name: 'Bash', tool_input: { command: 'psql --command="DELETE FROM users"' } }]);
  const transcript = path.join(root, 'transcript.jsonl'); writeFileSync(transcript, Array.from({ length: 8 }, (_, index) => JSON.stringify({ type: 'tool_use', name: 'Task', id: 'call-' + index })).join('\n')); cases.push(['subagent-fanout-guard', { tool_name: 'Task', transcript_path: transcript }]);
  cases.push(['foreground-process-guard', { tool_name: 'Bash', tool_input: { command: 'timeout 1 true; npm --prefix web run dev' } }]);
  for (const [slug, input] of cases) { const result = runHook(slug, input); assert.equal(result.status, 2, slug + ': ' + result.stderr); assert.match(result.stderr, /BLOCKED/, slug); }
});

test('hook processes fail closed on empty, malformed, and oversized envelopes', () => {
  for (const [slug, script] of Object.entries(scripts)) {
    for (const input of ['{}', '{bad', 'x'.repeat(1024 * 1024 + 1)]) {
      const result = spawnSync(process.execPath, [script], { input, encoding: 'utf8' }); assert.equal(result.status, 2, slug); assert.match(result.stderr, /input-invalid/, slug);
    }
  }
});

test('database adapter is restricted to database connector names', () => {
  const adapter = JSON.parse(readFileSync(path.resolve('artifacts/hooks/data/live-query-safety/database-query-mode-guard/adapters/claude-code.json'), 'utf8'));
  const matcher = new RegExp(adapter.settingsPatch.hooks.PreToolUse[0].matcher); assert.equal(matcher.test('mcp__search__query'), false); assert.equal(matcher.test('mcp__neon__run_sql'), true); assert.equal(matcher.test('Bash'), true);
});
