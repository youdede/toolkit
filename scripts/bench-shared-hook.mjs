#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Absolute time budget of the shared hook analysis (T3). `npm test` asserts only that the work scales
// linearly; this benchmark checks that the worst inputs finish within BUDGET_MS on this machine. Run
// it by hand after a change to scripts/lib/shared-hook/: `node scripts/bench-shared-hook.mjs`.

import { judgeCommand } from './lib/shared-hook/capability.mjs';
import { SHELL_ITEMS_MAX_BYTES, parseShell } from './lib/shared-hook/shell-items.mjs';

const BUDGET_MS = 2000;
const word = (text) => ({ kind: 'static', text });
const dynamic = { kind: 'pattern', text: '$X', parts: [{ any: 'expansion' }], splits: true };
const family = { executables: ['npm'], paths: [['publish']], safe: [{ on: ['--dry-run'], off: ['--no-dry-run'] }], rule: 'javascript-package-publish' };
const cap = { hook: 'bench', uninspectable: 'bench-uninspectable', families: [family, { ...family, paths: [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']] }] };
const inputs = {
  'unknown options': Array.from({ length: 60000 }, (_, index) => word(index % 2 ? 'x' : '-a')),
  'dynamic words': Array.from({ length: 60000 }, () => dynamic),
  'safe toggles': Array.from({ length: 60000 }, (_, index) => (index % 2 ? dynamic : word('--dry-run')))
};

let failed = false;
const report = (name, size, elapsed) => {
  failed ||= elapsed > BUDGET_MS;
  process.stdout.write(`${name}: ${size} in ${elapsed.toFixed(0)} ms${elapsed > BUDGET_MS ? ` (over ${BUDGET_MS} ms)` : ''}\n`);
};
// Parser inputs at the byte cap, each repeating one construct.
const units = ['a; ', 'echo $(a) `b` <(c) ', 'sudo -u x ', 'f(){ :; }; f; ', 'x{a,b} ', 'a | ', 'for x in a b; do $x; done; ',
  'case $x in a) b ;; esac; ', '[[ -n $x ]] && ', 'cat <<E\nx\nE\n', 'find . -exec ', '-x ', '"$(', '\\\n'];
for (const unit of units) {
  const text = unit.repeat(Math.floor(SHELL_ITEMS_MAX_BYTES / unit.length));
  const started = performance.now();
  parseShell(text);
  report(`parseShell ${JSON.stringify(unit)}`, `${text.length} bytes`, performance.now() - started);
}
for (const [name, words] of Object.entries(inputs)) {
  const view = { kind: 'command', key: 'npm', exe: word('npm'), words: [word('publish'), ...words], wrappers: [], assignments: [], redirections: [], stdinFrom: null, operator: '', changedDirectory: false, index: 0 };
  const started = performance.now();
  judgeCommand(view, cap);
  report(name, `${words.length} words`, performance.now() - started);
}
process.exitCode = failed ? 1 : 0;
