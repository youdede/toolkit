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
import * as h12 from '../artifacts/hooks/design/authentication-access/authentication-accessibility-guard/targets/claude-code/authentication-accessibility-guard.mjs';

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
  'foreground-process-guard': path.resolve('artifacts/hooks/operations/process-lifecycle/foreground-process-guard/targets/claude-code/foreground-process-guard.mjs'),
  'authentication-accessibility-guard': path.resolve('artifacts/hooks/design/authentication-access/authentication-accessibility-guard/targets/claude-code/authentication-accessibility-guard.mjs')
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
    [h11, { tool_name: 'Bash', tool_input: { command: 'npm run dev & echo ready' } }, {}],
    [h12, writeInput('Signup.jsx'), { file: 'Signup.jsx', before: '<input type="password" name="pw" />', proposed: '<input type="password" name="pw" autocomplete="new-password" />', complete: true }],
    [h12, writeInput('Login.jsx'), { file: 'Login.jsx', before: '<input type="password" name="pw" />', proposed: '<input type="password" name="pw" onKeyDown={e => e.preventDefault()} onPaste={handlePaste} />', complete: true }],
    [h12, writeInput('Search.jsx'), { file: 'Search.jsx', before: '<input type="search" name="q" />', proposed: '<input type="search" name="q" autocomplete="off" />', complete: true }],
    [h7, writeInput('index.html'), { file: 'index.html', before: '<meta name="viewport" content="width=device-width">', proposed: '<meta name="viewport" content="width=device-width, maximum-scale=2">', complete: true }],
    [h7, writeInput('Dialog.jsx'), { file: 'Dialog.jsx', before: '<button id="close">x</button>', proposed: '<button id="close" aria-hidden="true" tabindex="-1">x</button>', complete: true }]
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
  put('Login.tsx', '<input type="password" name="pw" autocomplete="current-password" />'); cases.push(['authentication-accessibility-guard', { tool_name: 'Write', cwd: root, tool_input: { file_path: 'Login.tsx', content: '<input type="password" name="pw" autocomplete="off" />' } }]);
  put('page.html', '<meta name="viewport" content="width=device-width">'); cases.push(['accessibility-attribute-regression-guard', { tool_name: 'Write', cwd: root, tool_input: { file_path: 'page.html', content: '<meta name="viewport" content="width=device-width, user-scalable=no">' } }]);
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

test('exception-swallowing-guard separates silent handlers from documented and idiomatic ones', (context) => {
  const root = mkdtempSync(path.join(tmpdir(), 'youdede-exception-precision-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  // want, label, file, before, proposed
  const cases = [
    ['allow', 'python optional-dependency import', 'opt.py', 'import sys\n', 'import sys\ntry:\n    import ujson\nexcept ImportError:\n    pass\n'],
    ['allow', 'python optional-dependency tuple', 'opt2.py', 'import sys\n', 'import sys\ntry:\n    import ujson\nexcept (ImportError, ModuleNotFoundError):\n    pass\n'],
    ['allow', 'block-comment documented catch', 'a.js', 'const a=1;\n', 'const a=1;\ntry { risky(); } catch (e) { /* intentional: best effort */ }\n'],
    ['allow', 'line-comment documented catch', 'b.js', 'const a=1;\n', 'const a=1;\ntry { risky(); } catch (e) {\n  // intentional: telemetry is best effort\n}\n'],
    ['allow', 'string literal describing a swallowed catch', 'c.js', 'const a=1;\n', 'const a=1;\nconst doc = "never write catch {} in this repo";\n'],
    ['allow', 'docstring describing a swallowed handler', 'd.py', 'x=1\n', 'x=1\ndef f():\n    """Do not write except: pass here."""\n    return 1\n'],
    ['allow', 'documented broad except', 'e.py', 'x=1\n', 'x=1\ntry:\n    risky()\nexcept Exception:  # deliberate: cleanup path\n    pass\n'],
    ['allow', 'documented ruby rescue', 'f.rb', 'x=1\n', 'x=1\nbegin\n  risky\nrescue\n  # deliberate: optional\nend\n'],
    ['block', 'silent javascript catch', 'g.js', 'const a=1;\n', 'const a=1;\ntry { risky(); } catch (e) {}\n'],
    ['block', 'bare python except pass', 'h.py', 'x=1\n', 'x=1\ntry:\n    risky()\nexcept:\n    pass\n'],
    ['block', 'silent broad python except', 'i.py', 'x=1\n', 'x=1\ntry:\n    risky()\nexcept Exception:\n    pass\n'],
    ['block', 'ignored promise rejection', 'j.js', 'const a=1;\n', 'const a=1;\np.catch(() => {});\n'],
    ['block', 'silent ruby rescue', 'k.rb', 'x=1\n', 'x=1\nbegin\n  risky\nrescue\nend\n'],
    ['block', 'apostrophe in a comment must not mask a real catch', 'l.js', 'const a=1;\n', "const a=1;\n// don't hide the next line\ntry { risky(); } catch (e) {}\n"]
  ];

  for (const [want, label, file, before, proposed] of cases) {
    const absolute = path.join(root, file);
    writeFileSync(absolute, before);
    const input = { tool_name: 'Write', cwd: root, tool_input: { file_path: absolute, content: proposed } };
    const result = h4.evaluate(input, h4.collectContext(input, root));
    assert.equal(result.exitCode, want === 'allow' ? 0 : 2, `${want}: ${label}`);
    if (want === 'block') assert.equal(result.ruleId, 'exception-swallowing-added', label);
  }
});

test('focus-style-regression-guard accepts the paired focus-visible pattern and still blocks real removals', (context) => {
  const root = mkdtempSync(path.join(tmpdir(), 'youdede-focus-precision-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const cases = [
    ['allow', 'recommended :focus / :focus-visible split', 'a.css', 'a { color: red; }\n',
      'a { color: red; }\na:focus { outline: none; }\na:focus-visible { outline: 2px solid #005fcc; }\n'],
    ['allow', 'split with a grouped selector', 'b.css', 'a { color: red; }\n',
      'a { color: red; }\n.btn:focus, .link:focus { outline: none; }\n.btn:focus-visible, .link:focus-visible { outline: 3px solid blue; }\n'],
    ['allow', 'suppressed outline replaced by a box-shadow ring', 'c.css', 'a { color: red; }\n',
      'a { color: red; }\na:focus { outline: none; box-shadow: 0 0 0 3px #005fcc; }\n'],
    ['block', 'outline removed with no replacement anywhere', 'd.css', 'a { color: red; }\n',
      'a { color: red; }\na:focus { outline: none; }\n'],
    ['block', 'focus-visible itself loses its indicator', 'e.css', 'a { color: red; }\n',
      'a { color: red; }\na:focus { outline: 2px solid blue; }\na:focus-visible { outline: none; }\n'],
    ['block', 'a different element supplies the only visible ring', 'f.css', 'a { color: red; }\n',
      'a { color: red; }\n.menu:focus { outline: none; }\n.other:focus-visible { outline: 2px solid blue; }\n']
  ];

  for (const [want, label, file, before, proposed] of cases) {
    const absolute = path.join(root, file);
    writeFileSync(absolute, before);
    const input = { tool_name: 'Write', cwd: root, tool_input: { file_path: absolute, content: proposed } };
    const result = h8.evaluate(input, h8.collectContext(input, root));
    assert.equal(result.exitCode, want === 'allow' ? 0 : 2, `${want}: ${label}`);
    if (want === 'block') assert.equal(result.ruleId, 'focus-indicator-removed', label);
  }
});

test('authentication-accessibility-guard blocks new credential barriers and leaves correct markup alone', (context) => {
  const root = mkdtempSync(path.join(tmpdir(), 'youdede-auth-access-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const cases = [
    ['allow', 'a password field gains the token that lets a manager fill it', 'a.jsx',
      '<input type="password" name="pw" />', '<input type="password" name="pw" autocomplete="current-password" />'],
    ['allow', 'a paste handler that reformats rather than refuses', 'b.jsx',
      '<input type="password" name="pw" />', '<input type="password" name="pw" onPaste={e => setValue(e.clipboardData.getData("text").trim())} />'],
    ['allow', 'preventDefault belongs to a different handler', 'c.jsx',
      '<input type="password" name="pw" />', '<input type="password" name="pw" onKeyDown={e => e.preventDefault()} onPaste={accept} />'],
    ['allow', 'a barrier the edit did not introduce', 'd.jsx',
      '<input type="password" name="pw" autocomplete="off" /><p>a</p>', '<input type="password" name="pw" autocomplete="off" /><p>b</p>'],
    ['block', 'paste refused on a password field', 'e.jsx',
      '<input type="password" name="pw" />', '<input type="password" name="pw" onPaste={e => e.preventDefault()} />', 'credential-paste-blocked'],
    ['block', 'paste refused inside a block body', 'f.jsx',
      '<input type="password" name="pw" />', '<input type="password" name="pw" onPaste={e => { e.preventDefault(); }} />', 'credential-paste-blocked'],
    ['block', 'autofill switched off on a password field', 'g.jsx',
      '<input type="password" name="pw" />', '<input type="password" name="pw" autocomplete="off" />', 'credential-autofill-disabled'],
    ['block', 'a one-time-code field loses its token', 'h.jsx',
      '<input name="code" autocomplete="one-time-code" />', '<input name="code" />', 'credential-autofill-removed'],
    ['block', 'a password manager is told to ignore the field', 'i.jsx',
      '<input type="password" name="pw" />', '<input type="password" name="pw" data-1p-ignore />', 'credential-manager-suppressed'],
    ['block', 'a vendor opt-out lands on a one-time-code field', 'j.jsx',
      '<input name="code" autocomplete="one-time-code" />', '<input name="code" autocomplete="one-time-code" data-lpignore="true" />', 'credential-manager-suppressed'],
    ['allow', 'the same opt-out on a field that holds no credential', 'k.jsx',
      '<input type="text" name="nick" />', '<input type="text" name="nick" data-1p-ignore />'],
    ['allow', 'an opt-out explicitly switched off', 'l.jsx',
      '<input type="password" name="pw" />', '<input type="password" name="pw" data-lpignore="false" />'],
    ['allow', 'renaming a field that already disabled autofill', 'm.jsx',
      '<input type="password" name="pw" autocomplete="off" />', '<input type="password" name="password" autocomplete="off" />'],
    ['allow', 'renaming a field that already refused paste', 'n.jsx',
      '<input type="password" name="pw" onpaste="return false" />', '<input type="password" name="password" onpaste="return false" />'],
    ['allow', 'wrapping a field that already opted out of managers', 'o.jsx',
      '<input type="password" name="pw" data-1p-ignore />', '<div className="row"><input type="password" name="pw" data-1p-ignore /></div>'],
    ['block', 'a second field gains a barrier beside one that had it', 'p.jsx',
      '<input type="password" name="a" autocomplete="off" /><input type="password" name="b" />',
      '<input type="password" name="a" autocomplete="off" /><input type="password" name="b" autocomplete="off" />', 'credential-autofill-disabled']
  ];

  for (const [want, label, file, before, proposed, ruleId] of cases) {
    const absolute = path.join(root, file);
    writeFileSync(absolute, before);
    const input = { tool_name: 'Write', cwd: root, tool_input: { file_path: absolute, content: proposed } };
    const result = h12.evaluate(input, h12.collectContext(input, root));
    assert.equal(result.exitCode, want === 'allow' ? 0 : 2, `${want}: ${label}`);
    if (want === 'block') assert.equal(result.ruleId, ruleId, label);
  }
});

// Both markup guards ended a tag at the first '>', which in JSX is the one inside an arrow
// function. Everything written after a handler was invisible to them.
test('markup guards read attributes written after a JSX arrow handler', (context) => {
  const root = mkdtempSync(path.join(tmpdir(), 'youdede-jsx-region-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const cases = [
    [h7, 'block', 'accessible name after a handler is removed', 'a.jsx',
      '<button id="save" onClick={() => save()} aria-label="Save document">S</button>',
      '<button id="save" onClick={() => save()}>S</button>'],
    [h7, 'block', 'alt after a handler is removed', 'b.jsx',
      '<img id="logo" onLoad={() => track()} alt="Company logo" />',
      '<img id="logo" onLoad={() => track()} />'],
    [h7, 'block', 'role after a handler is removed', 'c.jsx',
      '<div id="tab" onClick={() => go()} role="tab">Tab</div>',
      '<div id="tab" onClick={() => go()}>Tab</div>'],
    [h7, 'allow', 'a handler added beside a name that stays', 'd.jsx',
      '<button id="save" aria-label="Save document">S</button>',
      '<button id="save" onClick={() => save()} aria-label="Save document">S</button>'],
    [h12, 'block', 'autocomplete after a handler is switched off', 'e.jsx',
      '<input name="pw" type="password" onChange={(e) => set(e)} autocomplete="current-password" />',
      '<input name="pw" type="password" onChange={(e) => set(e)} autocomplete="off" />'],
    [h12, 'allow', 'a handler added beside a token that stays', 'f.jsx',
      '<input name="pw" type="password" autocomplete="current-password" />',
      '<input name="pw" type="password" onChange={(e) => set(e)} autocomplete="current-password" />']
  ];

  for (const [module, want, label, file, before, proposed] of cases) {
    const absolute = path.join(root, file);
    writeFileSync(absolute, before);
    const input = { tool_name: 'Write', cwd: root, tool_input: { file_path: absolute, content: proposed } };
    const result = module.evaluate(input, module.collectContext(input, root));
    assert.equal(result.exitCode, want === 'allow' ? 0 : 2, `${want}: ${label}`);
  }
});

// W3C ACT rule b4f0c3: user-scalable may not be no, and maximum-scale may not be below 2.
test('the markup guard holds the ACT zoom-rule boundary in both directions', (context) => {
  const root = mkdtempSync(path.join(tmpdir(), 'youdede-zoom-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const meta = (content) => `<meta name="viewport" content="${content}">`;

  const cases = [
    ['block', 'user-scalable=no', 'a.html', meta('width=device-width'), meta('width=device-width, user-scalable=no')],
    ['block', 'the numeric spelling of the same thing', 'b.html', meta('width=device-width'), meta('width=device-width, user-scalable=0')],
    ['block', 'maximum-scale just under the threshold', 'c.html', meta('width=device-width'), meta('width=device-width, maximum-scale=1.9')],
    ['allow', 'maximum-scale exactly at the threshold', 'd.html', meta('width=device-width'), meta('width=device-width, maximum-scale=2')],
    ['allow', 'user-scalable=yes', 'e.html', meta('width=device-width'), meta('width=device-width, user-scalable=yes')],
    ['allow', 'a suppression this edit did not introduce', 'f.html', `${meta('user-scalable=no')}<p>a</p>`, `${meta('user-scalable=no')}<p>b</p>`],
    ['allow', 'a suppression this edit removes', 'g.html', meta('user-scalable=no'), meta('width=device-width')],
    ['allow', 'a content value the page computes', 'h.jsx', '<meta name="viewport" content={a} />', '<meta name="viewport" content={b} />']
  ];

  for (const [want, label, file, before, proposed] of cases) {
    const absolute = path.join(root, file);
    writeFileSync(absolute, before);
    const input = { tool_name: 'Write', cwd: root, tool_input: { file_path: absolute, content: proposed } };
    const result = h7.evaluate(input, h7.collectContext(input, root));
    assert.equal(result.exitCode, want === 'allow' ? 0 : 2, `${want}: ${label}`);
    if (want === 'block') assert.equal(result.ruleId, 'viewport-zoom-suppressed', label);
  }
});

// W3C, Using ARIA: do not use role="presentation" or aria-hidden="true" on a focusable element.
test('accessibility-attribute-regression-guard blocks a focusable element hidden from assistive technology', (context) => {
  const root = mkdtempSync(path.join(tmpdir(), 'youdede-hidden-focusable-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const cases = [
    ['block', 'a button hidden while still focusable', 'a.jsx', '<button id="x">Go</button>', '<button id="x" aria-hidden="true">Go</button>'],
    ['block', 'a link hidden while still focusable', 'b.jsx', '<a id="y" href="/a">A</a>', '<a id="y" href="/a" aria-hidden="true">A</a>'],
    ['block', 'presentation role on a tabbable div', 'c.jsx', '<div id="z" tabindex="0">Z</div>', '<div id="z" tabindex="0" role="presentation">Z</div>'],
    ['allow', 'hidden and taken out of the tab order together', 'd.jsx', '<button id="x">Go</button>', '<button id="x" aria-hidden="true" tabindex="-1">Go</button>'],
    ['allow', 'a decorative span', 'e.jsx', '<span id="s">*</span>', '<span id="s" aria-hidden="true">*</span>'],
    ['allow', 'a disabled control', 'f.jsx', '<button id="x" disabled>Go</button>', '<button id="x" disabled aria-hidden="true">Go</button>'],
    ['allow', 'an anchor with no href', 'g.jsx', '<a id="n">n</a>', '<a id="n" aria-hidden="true">n</a>'],
    ['allow', 'a pairing this edit did not introduce', 'h.jsx', '<button id="x" aria-hidden="true">a</button>', '<button id="x" aria-hidden="true">b</button>']
  ];

  for (const [want, label, file, before, proposed] of cases) {
    const absolute = path.join(root, file);
    writeFileSync(absolute, before);
    const input = { tool_name: 'Write', cwd: root, tool_input: { file_path: absolute, content: proposed } };
    const result = h7.evaluate(input, h7.collectContext(input, root));
    assert.equal(result.exitCode, want === 'allow' ? 0 : 2, `${want}: ${label}`);
    if (want === 'block') assert.equal(result.ruleId, 'accessibility-hidden-focusable', label);
  }
});
