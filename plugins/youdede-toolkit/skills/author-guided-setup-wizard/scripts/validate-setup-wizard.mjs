#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  process.stderr.write('usage: validate-setup-wizard.mjs <wizard.sh>\n');
  process.exit(2);
}
const raw = readFileSync(file, 'utf8');
const errors = [];
if (!raw.startsWith('#!/usr/bin/env bash') && !raw.startsWith('#!/bin/bash')) errors.push('wizard needs a Bash shebang');
// ponytail: drops `#` comments at line start or after whitespace; a `#` inside quotes after a space is cut too.
const code = raw.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '$1')).join('\n');
if (!/set\s+-[^\n]*e/.test(code) || !/set\s+-[^\n]*u/.test(code) || !/pipefail/.test(code)) errors.push('wizard needs strict mode with errexit, nounset, and pipefail');
if (/\bset\s+-[A-Za-z]*x|\bset\s+-o\s+xtrace\b/.test(code)) errors.push('wizard must not enable shell tracing');
if (/\beval\b|\bsource\s+<\(/.test(code)) errors.push('wizard must not use eval or source process substitution');
if (/(?:echo|printf)[^\n]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(code)) errors.push('wizard may expose a secret-like variable');
// Lexical checks only: secret-like names are recognized by their spelling, not by data flow.
const SECRET_NAME = /^[A-Za-z_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*$/i;
for (const line of code.split('\n')) {
  const read = /\bread\b((?:\s+-[A-Za-z]+(?:\s+(?:"[^"]*"|'[^']*'|\S+))?)*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line.trim());
  if (read && SECRET_NAME.test(read[2]) && !/\s-[A-Za-z]*s/.test(` ${read[1]}`)) errors.push(`secret-like variable ${read[2]} is read without -s (visible input)`);
  const expanded = [...line.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]).filter((name) => SECRET_NAME.test(name));
  if (expanded.length && /\b(?:curl|wget|http|gh|git|ssh|mysql|psql)\b/.test(line)) errors.push(`secret-like variable ${expanded[0]} is passed on a command line`);
}
const total = /TOTAL_STAGES\s*=\s*([0-9]+)/.exec(raw)?.[1];
const stageCount = (raw.match(/^stage\s+['"]/gm) || []).length;
if (!total) errors.push('wizard must declare TOTAL_STAGES');
else if (Number(total) !== stageCount) errors.push(`TOTAL_STAGES is ${total} but found ${stageCount} stage calls`);
if (!/\bconfirm\w*\b|\bread\s+-[^\n]*p/.test(code)) errors.push('wizard needs an interactive confirmation function or prompt');
const syntax = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
if (syntax.status !== 0) errors.push(`bash -n failed: ${(syntax.stderr || syntax.stdout).trim()}`);
process.stdout.write(JSON.stringify({ valid: errors.length === 0, errors, stageCount }, null, 2) + '\n');
if (errors.length) process.exit(1);
