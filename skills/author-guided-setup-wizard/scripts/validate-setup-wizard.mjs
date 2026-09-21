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
if (!/set\s+-[^\n]*e/.test(raw) || !/set\s+-[^\n]*u/.test(raw) || !/pipefail/.test(raw)) errors.push('wizard needs strict mode with errexit, nounset, and pipefail');
if (/set\s+-[^\n]*x/.test(raw)) errors.push('wizard must not enable shell tracing');
if (/\beval\b|\bsource\s+<\(/.test(raw)) errors.push('wizard must not use eval or source process substitution');
if (/(?:echo|printf)[^\n]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(raw)) errors.push('wizard may expose a secret-like variable');
const total = /TOTAL_STAGES\s*=\s*([0-9]+)/.exec(raw)?.[1];
const stageCount = (raw.match(/^stage\s+['"]/gm) || []).length;
if (!total) errors.push('wizard must declare TOTAL_STAGES');
else if (Number(total) !== stageCount) errors.push(`TOTAL_STAGES is ${total} but found ${stageCount} stage calls`);
if (!/confirm|read\s+-[^\n]*p/.test(raw)) errors.push('wizard needs an interactive confirmation function or prompt');
const syntax = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
if (syntax.status !== 0) errors.push(`bash -n failed: ${(syntax.stderr || syntax.stdout).trim()}`);
process.stdout.write(JSON.stringify({ valid: errors.length === 0, errors, stageCount }, null, 2) + '\n');
if (errors.length) process.exit(1);
