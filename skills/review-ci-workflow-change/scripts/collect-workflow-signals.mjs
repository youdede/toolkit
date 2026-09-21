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
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    const type = /\bsecrets\./.test(trimmed) ? 'secret-reference'
      : /^on\s*:/.test(trimmed) ? 'event-declaration'
      : /^permissions\s*:/.test(trimmed) || /^[a-z-]+\s*:\s*(?:write|read-all|write-all)\s*$/.test(trimmed) ? 'permission-declaration'
        : /^uses\s*:/.test(trimmed) || /\buses\s*:/.test(trimmed) ? 'action-reference'
          : /^run\s*:/.test(trimmed) || /\brun\s*:/.test(trimmed) ? 'run-command' : null;
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
