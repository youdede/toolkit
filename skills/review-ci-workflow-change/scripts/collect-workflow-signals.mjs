#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 512 * 1024;
const MAX_SIGNALS = 200;
export function collectWorkflowSignals(text) {
  if (typeof text !== 'string') throw new Error('workflow input must be text');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`workflow input exceeds ${MAX_BYTES} bytes`);
  const signals = [];
  const indent = (line) => line.length - line.trimStart().length;
  // Open blocks: the `on:` mapping (its child keys are events) and `run: |` scalars (their lines are commands).
  let onBlock = null;
  let runBlock = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const depth = indent(line);
    if (runBlock !== null && depth <= runBlock) runBlock = null;
    if (onBlock && depth <= onBlock.indent) onBlock = null;
    const secret = /\bsecrets\.|\bsecrets\s*:\s*inherit\b|\bgithub\.token\b/.test(trimmed);
    let type;
    if (secret) type = 'secret-reference';
    else if (runBlock !== null) type = 'run-command';
    else if (/^["']?on["']?\s*:/.test(trimmed)) type = 'event-declaration';
    else if (onBlock && /^["']?[A-Za-z_][\w-]*["']?\s*:/.test(trimmed) && depth === (onBlock.child ??= depth)) type = 'event-declaration';
    else if (/^permissions\s*:/.test(trimmed) || /^[a-z-]+\s*:\s*(?:read|write|none|read-all|write-all)\s*$/.test(trimmed)) type = 'permission-declaration';
    else if (/\buses\s*:/.test(trimmed)) type = 'action-reference';
    else if (/^(?:-\s*)?run\s*:|[{,]\s*run\s*:/.test(trimmed)) type = 'run-command';
    else type = null;
    if (/^["']?on["']?\s*:\s*(?:#.*)?$/.test(trimmed)) onBlock = { indent: depth, child: null };
    if (/^(?:-\s*)?run\s*:\s*[|>][-+0-9]*\s*(?:#.*)?$/.test(trimmed)) runBlock = depth + (trimmed.startsWith('-') ? 2 : 0);
    if (type) signals.push({ line: index + 1, type, text: trimmed.slice(0, 240) });
  }
  return { schemaVersion: 1, inputBytes: Buffer.byteLength(text), parser: 'line-signal-collector', signals: signals.slice(0, MAX_SIGNALS), truncated: signals.length > MAX_SIGNALS };
}
function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--file') throw new Error('usage: collect-workflow-signals.mjs --file <workflow-file>');
  const file = path.resolve(argv[1]);
  if (statSync(file).size > MAX_BYTES) throw new Error(`workflow input exceeds ${MAX_BYTES} bytes`);
  process.stdout.write(`${JSON.stringify({ file: path.basename(file), ...collectWorkflowSignals(readFileSync(file, 'utf8')) }, null, 2)}\n`);
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) { try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`collect-workflow-signals: ${error.message}\n`); process.exitCode = 1; } }
