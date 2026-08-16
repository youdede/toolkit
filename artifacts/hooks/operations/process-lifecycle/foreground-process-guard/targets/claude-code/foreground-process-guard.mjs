#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_COMMAND_BYTES = 256 * 1024;
function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by foreground-process-guard [' + ruleId + ']: ' + detail + '.' }; }

export function collectContext() { return {}; }

function commandUnits(command) {
  const units = []; let text = ''; let quote = ''; let escaped = false;
  const push = (background = false) => { if (text.trim()) units.push({ text: text.trim(), background }); text = ''; };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]; const next = command[index + 1];
    if (escaped) { text += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { text += character; escaped = true; continue; }
    if (quote) { text += character; if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; text += character; continue; }
    if (character === '\n' || character === ';') { push(false); continue; }
    if (character === '&') { push(next !== '&'); if (next === '&') index += 1; continue; }
    if (character === '|' && next === '|') { push(false); index += 1; continue; }
    text += character;
  }
  push(false);
  return { units, balanced: !quote && !escaped };
}
function isIndefinite(unit) {
  return /\b(?:npm|pnpm|yarn|bun)\b(?:\s+--?[\w-]+(?:=\S+|\s+\S+)?)*\s+(?:run\s+)?(?:dev|start|serve|watch)\b/i.test(unit)
    || /(?:^|[|]\s*|\bnpx\s+|\bbunx\s+|\bpnpm\s+(?:dlx|exec)\s+)(?:vite(?:\s|$)|next\s+(?:dev|start)\b|webpack(?:-dev-server|\s+serve)\b|rollup\b[^|;\n]*(?:--watch|-w)\b|tsc\b[^|;\n]*(?:--watch|-w)\b)/i.test(unit)
    || /\b(?:nodemon|watchexec|entr)\b|\btail\s+(?:[^|;\n]*\s)?-f\b|\bjournalctl\b[^|;\n]*\s-f\b/i.test(unit)
    || /\bpython(?:3)?\s+-m\s+http\.server\b|\brails\s+(?:server|s)\b|\buvicorn\s+\S+|\bgunicorn\s+\S+/i.test(unit)
    || /\bdocker(?:\s+compose|-compose)\s+up\b(?![^|;\n]*\s-d\b)|\bkubectl\s+port-forward\b/i.test(unit);
}
function isBounded(unit) {
  if (unit.background) return true;
  const text = unit.text;
  if (/^(?:\s*[A-Za-z_]\w*=\S+\s+)*(?:timeout|gtimeout)\s+(?:--?\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+/i.test(text)) return true;
  if (/^(?:tmux\s+(?:new-session|new)\b[^\n]*\s-d\b|screen\s+-[^\s]*d[^\s]*\b|systemd-run\b|Start-Job\b|Start-Process\b)/i.test(text)) return true;
  return /(?:^|\s)(?:--help|--version|-h|-V)(?:\s|$)/.test(text);
}
export function evaluate(input) {
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_name) return block('foreground-process-input-invalid', 'the hook envelope is incomplete');
  if (!/^(?:Bash|PowerShell)$/.test(input.tool_name)) return allow();
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return block('foreground-process-input-invalid', 'the shell command is missing');
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) return block('foreground-command-uninspectable', 'the process command exceeds the bounded inspection limit');
  const parsed = commandUnits(command);
  if (!parsed.balanced) return block('foreground-command-uninspectable', 'the process command has an unterminated quoted segment');
  for (const unit of parsed.units) {
    if (!isIndefinite(unit.text)) continue;
    if (/\x60|\$\(|\$\{|\b(?:eval|source)\b/.test(unit.text)) return block('foreground-command-uninspectable', 'a dynamic process command cannot be proven bounded');
    if (!isBounded(unit)) return block('indefinite-foreground-process', 'a recognizable server, watcher, or follow process lacks a timeout or detached boundary');
  }
  return allow();
}

async function receiveEnvelope() {
  const chunks = []; let received = 0;
  for await (const chunk of process.stdin) { received += chunk.length; if (received > MAX_STDIN_BYTES) throw new Error('hook input exceeds bounded size'); chunks.push(chunk); }
  try { const raw = Buffer.concat(chunks).toString('utf8'); return raw.trim() ? JSON.parse(raw) : {}; }
  catch { throw new Error('hook input is not valid JSON'); }
}
async function runHook() {
  let result;
  try { const input = await receiveEnvelope(); result = evaluate(input); }
  catch (error) { result = block('foreground-process-input-invalid', error.message); }
  if (result.message) process.stderr.write(result.message + '\n'); process.exitCode = result.exitCode;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
