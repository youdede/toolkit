#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_GITMODULES_BYTES = 256 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;

function protectedFile(value) {
  return typeof value === 'string' && value.replaceAll('\\', '/').replace(/^\.\//, '') === '.gitmodules';
}

function targetClass(value) {
  const target = value.trim();
  if (!target || /\$\{|\$\(|`|[\0\r\n]/.test(target)) return 'submodule-target-dynamic';
  if (/^(?:\.{1,2}[/\\]|[/\\]|~[/\\]|file:|ext::)/i.test(target)) return 'submodule-target-local';
  if (/^(?:http|git|ftp):\/\//i.test(target)) return 'submodule-target-insecure';
  if (/^https:\/\/[^\s]+$/i.test(target) || /^ssh:\/\/[^\s]+$/i.test(target) || /^git@[^:\s]+:[^\s]+$/.test(target)) return null;
  return 'submodule-target-unrecognized';
}

export function scanGitmodules(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_GITMODULES_BYTES) throw new Error('gitmodules content exceeds bounds');
  const findings = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const heading = /^\[submodule\s+"([^"]+)"\]$/i.exec(line);
    if (heading) { section = heading[1]; continue; }
    const pair = /^([A-Za-z][A-Za-z0-9.-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!pair || !section) continue;
    const key = pair[1].toLowerCase();
    if (key === 'branch') findings.push({ ruleId: 'submodule-branch-tracking', identity: `${section}:branch` });
    if (key === 'update' && pair[2].startsWith('!')) findings.push({ ruleId: 'submodule-update-command', identity: `${section}:update-command` });
    if (key === 'url') {
      const ruleId = targetClass(pair[2]);
      if (ruleId) findings.push({ ruleId, identity: `${section}:url:${ruleId}:${pair[2].trim()}` });
    }
  }
  return findings;
}

function shellWords(command) {
  if (typeof command !== 'string' || Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new Error('command invalid or oversized');
  if (/[\n\r;&|<>]|\$\(|`/.test(command)) return null;
  const words = []; let word = ''; let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = '';
      else if (quote === '"' && character === '\\' && index + 1 < command.length) word += command[++index];
      else word += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) { if (word) { words.push(word); word = ''; } }
    else if (character === '\\' && index + 1 < command.length) word += command[++index];
    else word += character;
  }
  if (quote) return null;
  if (word) words.push(word);
  return words;
}

function normalizeCommand(command, depth = 0) {
  const words = shellWords(command);
  if (!words || depth > 3) return null;
  let cursor = 0; while (/^[A-Za-z_]\w*=/.test(words[cursor] || '')) cursor += 1;
  if (path.basename(words[cursor] || '') === 'env') { cursor += 1; while (words[cursor] && (words[cursor].startsWith('-') || /^[A-Za-z_]\w*=/.test(words[cursor]))) cursor += ['-u', '--unset', '-C', '--chdir'].includes(words[cursor]) ? 2 : 1; }
  if (path.basename(words[cursor] || '') === 'command') { cursor += 1; while (words[cursor]?.startsWith('-')) cursor += 1; }
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(path.basename(words[cursor] || ''))) { const option = words.findIndex((token, index) => index > cursor && /^-[^-]*c/.test(token)); return option >= 0 && words[option + 1] ? normalizeCommand(words[option + 1], depth + 1) : null; }
  if (!words[cursor]) return null;
  return [path.basename(words[cursor]).toLowerCase(), ...words.slice(cursor + 1)];
}

export function inspectSubmoduleCommand(command) {
  let words;
  try { words = normalizeCommand(command); } catch { return { ruleId: 'submodule-command-too-large' }; }
  if (!words) return /\bgit\s+submodule\s+add\b/.test(String(command)) ? { ruleId: 'submodule-command-uninspectable' } : null;
  let cursor = 0;
  if (words[cursor] !== 'git') return null;
  cursor += 1;
  while (words[cursor]?.startsWith('-') && words[cursor] !== '--') {
    if (['-C', '-c', '--git-dir', '--work-tree'].includes(words[cursor])) cursor += 2;
    else cursor += 1;
  }
  if (words[cursor] !== 'submodule' || words[cursor + 1] !== 'add') return null;
  const rest = words.slice(cursor + 2);
  if (rest.some((item) => item === '-b' || item === '--branch' || item.startsWith('--branch='))) return { ruleId: 'submodule-branch-tracking' };
  if (rest.some((item) => /\$\{|\$[A-Za-z_]/.test(item))) return { ruleId: 'submodule-command-uninspectable' };
  const positional = rest.filter((item, index) => {
    if (item === '--') return false;
    if (item.startsWith('-')) return false;
    const prior = rest[index - 1];
    return !['--name', '--reference', '--ref-format'].includes(prior);
  });
  if (!positional.length) return { ruleId: 'submodule-command-uninspectable' };
  const ruleId = targetClass(positional[0]);
  return ruleId ? { ruleId } : null;
}

function patchFile(existing, payload) {
  if (typeof payload.content === 'string') return payload.content;
  let output = existing;
  for (const edit of Array.isArray(payload.edits) ? payload.edits : [payload]) {
    if (typeof edit?.old_string !== 'string' || !edit.old_string || typeof edit?.new_string !== 'string') throw new Error('incomplete edit');
    const count = output.split(edit.old_string).length - 1;
    if (edit.replace_all === true && count) output = output.split(edit.old_string).join(edit.new_string);
    else if (count === 1) output = output.replace(edit.old_string, edit.new_string);
    else throw new Error('edit target is not unique');
  }
  return output;
}

export function collectContext(input, cwd = process.cwd()) {
  const payload = input?.tool_input || input?.toolInput || {};
  if (!protectedFile(payload.file_path || payload.file)) return { relevant: false };
  try {
    const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
    const target = path.resolve(root, '.gitmodules');
    let before = '';
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GITMODULES_BYTES) throw new Error('unsafe target');
      before = readFileSync(target, 'utf8');
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return { relevant: true, before, after: patchFile(before, payload) };
  } catch { return { relevant: true, invalid: true }; }
}

export function evaluate(input, context = {}) {
  const payload = input?.tool_input || input?.toolInput || {};
  if (typeof payload.command === 'string') {
    const finding = inspectSubmoduleCommand(payload.command);
    return finding ? { exitCode: 2, ruleId: finding.ruleId, message: 'The submodule command has an unsafe or unverifiable target policy.' } : { exitCode: 0 };
  }
  if (!context.relevant) return { exitCode: 0 };
  if (context.invalid) return { exitCode: 2, ruleId: 'submodule-file-inspection-incomplete', message: 'The complete .gitmodules change could not be inspected.' };
  try {
    const previous = new Set(scanGitmodules(context.before).map((item) => item.identity));
    const added = scanGitmodules(context.after).find((item) => !previous.has(item.identity));
    return added ? { exitCode: 2, ruleId: added.ruleId, message: 'The .gitmodules change adds unsafe or mutable submodule behavior.' } : { exitCode: 0 };
  } catch {
    return { exitCode: 2, ruleId: 'submodule-input-invalid', message: 'Submodule policy received malformed or oversized input.' };
  }
}

async function main() {
  try {
    const parts = []; let size = 0;
    for await (const part of process.stdin) { size += part.length; if (size > MAX_STDIN_BYTES) throw new Error('input exceeds the bounded limit'); parts.push(part); }
    const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const result = evaluate(input, collectContext(input));
    if (result.exitCode) process.stderr.write(`[${result.ruleId}] ${result.message}\n`);
    process.exitCode = result.exitCode;
  } catch { process.stderr.write('[input-invalid] Hook input is invalid or oversized.\n'); process.exitCode = 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
