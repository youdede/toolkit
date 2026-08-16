#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;
const PASS = Object.freeze({ exitCode: 0 });
const deny = (ruleId, detail) => ({
  exitCode: 2,
  ruleId,
  message: `BLOCKED by scheduled-task-mutation-guard [${ruleId}]: ${detail}`
});

const basename = (candidate) => path.posix.basename(String(candidate || '').replaceAll('\\', '/')).toLowerCase();
const assignment = (candidate) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate || '');

/* Parse only the shell surface needed to determine the executable and its literal
   arguments. The hook never expands variables or executes substitutions. */
function shellClauses(script) {
  if (typeof script !== 'string' || Buffer.byteLength(script) > MAX_COMMAND_BYTES) throw new Error('command outside bounds');
  const clauses = []; let argv = []; let token = ''; let quote = ''; let escaped = false; let tainted = false;
  const finishToken = () => { if (token || tainted) argv.push({ text: token, tainted }); token = ''; tainted = false; };
  const finishClause = () => { finishToken(); if (argv.length) clauses.push(argv); argv = []; };
  for (let offset = 0; offset < script.length; offset += 1) {
    const character = script[offset];
    if (escaped) { token += character; escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = '';
      else { token += character; if (quote === '"' && (character === '$' || character === '`')) tainted = true; }
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '#' && token.length === 0) { while (offset < script.length && script[offset] !== '\n') offset += 1; finishClause(); continue; }
    if (character === '$' || character === '`') { token += character; tainted = true; continue; }
    if (/\s/.test(character)) { finishToken(); if (character === '\n') finishClause(); continue; }
    if (character === ';' || character === '&' || character === '|') { finishClause(); if (script[offset + 1] === character) offset += 1; continue; }
    token += character;
  }
  if (quote || escaped) throw new Error('incomplete shell syntax');
  finishClause();
  return clauses;
}

function advanceOptions(argv, cursor, valueOptions) {
  while (argv[cursor]?.text.startsWith('-') && argv[cursor].text !== '--') {
    const option = argv[cursor].text;
    cursor += !option.includes('=') && valueOptions.has(option) ? 2 : 1;
  }
  return argv[cursor]?.text === '--' ? cursor + 1 : cursor;
}

function executableInvocation(argv, nesting = 0) {
  let cursor = 0;
  while (assignment(argv[cursor]?.text)) cursor += 1;
  for (;;) {
    const wrapper = basename(argv[cursor]?.text);
    if (wrapper === 'env') {
      cursor += 1;
      while (argv[cursor] && (assignment(argv[cursor].text) || argv[cursor].text.startsWith('-'))) {
        if (assignment(argv[cursor].text)) cursor += 1;
        else cursor += !argv[cursor].text.includes('=') && ['-u', '--unset', '-C', '--chdir'].includes(argv[cursor].text) ? 2 : 1;
      }
      continue;
    }
    if (['command', 'nohup', 'setsid'].includes(wrapper)) { cursor = advanceOptions(argv, cursor + 1, new Set()); continue; }
    if (['sudo', 'doas'].includes(wrapper)) { cursor = advanceOptions(argv, cursor + 1, new Set(['-u', '-g', '-h', '-p', '-C', '-T', '--user', '--group', '--host', '--prompt', '--chdir'])); continue; }
    if (wrapper === 'nice' || wrapper === 'time') { cursor = advanceOptions(argv, cursor + 1, new Set(['-n', '--adjustment', '-f', '--format', '-o', '--output'])); continue; }
    if (wrapper === 'timeout') {
      cursor = advanceOptions(argv, cursor + 1, new Set(['-k', '--kill-after', '-s', '--signal']));
      if (argv[cursor]) cursor += 1;
      continue;
    }
    if (['sh', 'bash', 'dash', 'ksh', 'zsh'].includes(wrapper)) {
      const commandOption = argv.findIndex((item, index) => index > cursor && (/^-[^-]*c/.test(item.text) || item.text === '--command'));
      if (nesting >= 3 || commandOption < 0 || !argv[commandOption + 1] || argv[commandOption + 1].tainted) return [{ invalid: true }];
      return normalizedInvocations(argv[commandOption + 1].text, nesting + 1);
    }
    break;
  }
  if (!argv[cursor]) return [{ invalid: true }];
  return [{
    program: basename(argv[cursor].text),
    programTainted: argv[cursor].tainted,
    parameters: argv.slice(cursor + 1),
    tainted: argv.slice(cursor + 1).some((item) => item.tainted)
  }];
}

function normalizedInvocations(script, nesting = 0) {
  return shellClauses(script).flatMap((argv) => executableInvocation(argv, nesting));
}

function scheduleMutation(invocation) {
  const relevant = new Set(['crontab', 'at', 'atq', 'atrm', 'batch', 'schtasks', 'schtasks.exe', 'launchctl', 'systemd-run', 'pmset']);
  if (!relevant.has(invocation.program)) return null;
  if (invocation.programTainted || invocation.tainted) return 'scheduled-task-command-uninspectable';
  const args = invocation.parameters.map((item) => item.text);
  if (invocation.program === 'crontab') {
    const operation = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '-u') index += 1;
      else operation.push(args[index]);
    }
    return operation.length === 1 && ['-l', '--list'].includes(operation[0]) ? null : 'cron-table-mutation';
  }
  if (invocation.program === 'atq') return null;
  if (invocation.program === 'atrm' || invocation.program === 'batch') return 'at-job-mutation';
  if (invocation.program === 'at') {
    const onlyListing = args.some((item) => item === '-l' || item === '--list') && !args.some((item) => item === '-r' || item === '--remove');
    return onlyListing ? null : 'at-job-mutation';
  }
  if (invocation.program === 'schtasks' || invocation.program === 'schtasks.exe') {
    return args.some((item) => /^\/(?:create|delete|change|run|end)$/i.test(item)) ? 'windows-task-mutation' : null;
  }
  if (invocation.program === 'launchctl') {
    return ['bootstrap', 'bootout', 'load', 'unload', 'enable', 'disable', 'kickstart', 'remove', 'submit'].includes(args[0]?.toLowerCase()) ? 'launchd-schedule-mutation' : null;
  }
  if (invocation.program === 'systemd-run') return args.some((item) => /^--on-(?:active|boot|startup|unit-active|unit-inactive|calendar)=?/.test(item)) ? 'systemd-transient-schedule-mutation' : null;
  if (invocation.program === 'pmset') return args[0]?.toLowerCase() === 'repeat' ? 'power-schedule-mutation' : null;
  return null;
}

export function evaluate(input) {
  if (!input || typeof input !== 'object' || !input.tool_input || typeof input.tool_input !== 'object') return deny('scheduled-task-mutation-input-invalid', 'the hook input is malformed.');
  if (input.tool_name !== 'Bash') return PASS;
  let invocations;
  try { invocations = normalizedInvocations(input.tool_input.command); }
  catch { return deny('scheduled-task-command-uninspectable', 'the command cannot be parsed within the fixed inspection bounds.'); }
  if (invocations.some((invocation) => invocation.invalid)) return deny('scheduled-task-command-uninspectable', 'the command uses a shell form whose schedule intent is not statically knowable.');
  for (const invocation of invocations) {
    const ruleId = scheduleMutation(invocation);
    if (ruleId) return deny(ruleId, 'the command changes persistent or deferred task execution and requires explicit review.');
  }
  return PASS;
}

async function receiveEnvelope() {
  const fragments = []; let received = 0;
  for await (const fragment of process.stdin) {
    received += fragment.length;
    if (received > MAX_STDIN_BYTES) throw new Error('oversized input');
    fragments.push(fragment);
  }
  return JSON.parse(Buffer.concat(fragments).toString('utf8'));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const decision = evaluate(await receiveEnvelope());
    if (decision.exitCode) process.stderr.write(`${decision.message}\n`);
    process.exitCode = decision.exitCode;
  } catch {
    process.stderr.write('BLOCKED by scheduled-task-mutation-guard [scheduled-task-mutation-input-invalid]: hook input is invalid or oversized.\n');
    process.exitCode = 2;
  }
}
