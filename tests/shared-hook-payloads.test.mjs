import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateSharedHooks, loadSharedModules, renderSharedBlocks } from '../scripts/generate-shared-hooks.mjs';

// Probes of the payloads that embed the shared hook modules, and of the generator that embeds them.
// The process probes run against every payload with the `shell-items` block, so a hook that adopts
// the parser is covered without new test code. The modules' own contracts are in
// tests/shared-hook-items.test.mjs, tests/shared-hook-capability.test.mjs, and
// tests/shared-hook-commit.test.mjs.

function sharedShellPayloads() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.mjs') && /\/\/ <youdede:shared shell-items>/.test(readFileSync(next, 'utf8'))) files.push(next);
    }
  };
  walk(path.resolve('artifacts'));
  return files;
}

test('every hook with the shell-items block ends in bounded time as a process', { timeout: 10 * 60 * 1000 }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-shared-shell-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const payloads = sharedShellPayloads();
  assert.equal(payloads.length, 31, 'every Bash hook embeds the shell-items block');
  for (const script of payloads) {
    for (const command of ['sudo --', 'sudo -- sudo -- git commit -m x', 'sudo -- '.repeat(20000), '$('.repeat(100000), 'find . -exec '.repeat(15000),
      'f(){ :; }; f; '.repeat(18000)]) {
      const started = performance.now();
      const result = spawnSync(process.execPath, [script], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: directory }),
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000
      });
      const label = `${path.basename(script)} ${JSON.stringify(command.slice(0, 30))}`;
      assert.equal(result.signal, null, `${label} was killed after ${Math.round(performance.now() - started)} ms`);
      assert.ok([0, 2].includes(result.status), `${label} exited ${result.status}`);
    }
  }
});

test('the generator keeps every shared block in sync and rejects broken markers', () => {
  const { problems, stale, embedded } = generateSharedHooks({ check: true });
  assert.deepEqual(problems, []);
  assert.deepEqual(stale, []);
  assert.ok(embedded >= 2);

  const modules = loadSharedModules();
  const block = (name) => `// <youdede:shared ${name}>\n// </youdede:shared>`;
  const rendered = renderSharedBlocks(`a\n${block('shell-items')}\n${block('capability')}\n${block('commit-content')}\nb\n`, modules);
  assert.deepEqual(rendered.errors, []);
  assert.equal(renderSharedBlocks(rendered.text, modules).text, rendered.text, 'rendering is idempotent');
  assert.ok(rendered.text.includes('export function parseShell('));
  assert.ok(rendered.text.includes('export function commitIntent('));
  assert.doesNotMatch(rendered.text, /^import /m);

  const errors = (source) => renderSharedBlocks(source, modules).errors.join('\n');
  assert.match(errors(`${block('shell-items')}\n${block('shell-items')}`), /duplicate shared block shell-items/);
  assert.match(errors('// <youdede:shared shell-items>\nx'), /shell-items is not closed/);
  assert.match(errors('x\n// </youdede:shared>'), /closes without an opening marker/);
  assert.match(errors('// <youdede:shared shell-items>\n// <youdede:shared commit-content>\n// </youdede:shared>'), /opens inside shell-items/);
  assert.match(errors(block('nope')), /unknown shared module nope/);
  // The first shell analysis and the inline-script reader are gone.
  assert.match(errors(block('shell')), /unknown shared module shell/);
  assert.match(errors(block('inline-script')), /unknown shared module inline-script/);
  assert.match(errors('// <youdede:shared shell-items >\n// </youdede:shared>'), /malformed shared marker/);
  assert.match(errors('//<youdede:shared shell-items>'), /malformed shared marker/);
  assert.match(errors(block('commit-content')), /commit-content requires the capability block/);
  assert.match(errors(block('commit-content')), /commit-content requires the shell-items block/);
});
