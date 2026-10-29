#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const PHASES = ['spec', 'design', 'tasks', 'implementation'];
const EVIDENCE_PATTERN = /^\.youdede\/phases\/([a-z-]+)\.json$/;

function allow() { return { exitCode: 0, message: '' }; }
function block(ruleId, detail) { return { exitCode: 2, ruleId, message: 'BLOCKED by phase-gate-guard [' + ruleId + ']: ' + detail + '.' }; }
function within(root, candidate) { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }

function rebuildProposed(input, before) {
  const tool = input?.tool_input || {};
  if (typeof tool.content === 'string') return { complete: true, proposed: tool.content };
  const edits = Array.isArray(tool.edits) ? tool.edits : (typeof tool.old_string === 'string' ? [tool] : []);
  let proposed = before;
  for (const edit of edits) {
    if (typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string' || !edit.old_string) return { complete: false, proposed: '' };
    const position = proposed.indexOf(edit.old_string);
    if (position < 0 || (edit.replace_all !== true && proposed.indexOf(edit.old_string, position + edit.old_string.length) >= 0)) return { complete: false, proposed: '' };
    proposed = edit.replace_all === true ? proposed.split(edit.old_string).join(edit.new_string) : proposed.slice(0, position) + edit.new_string + proposed.slice(position + edit.old_string.length);
  }
  return { complete: true, proposed };
}

function evidenceError(raw, expectedPhase) {
  if (typeof raw !== 'string' || raw.length === 0) return 'empty';
  if (Buffer.byteLength(raw, 'utf8') > MAX_EVIDENCE_BYTES) return 'oversized';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'not-json';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'not-object';
  if (parsed.phase !== expectedPhase) return 'phase-mismatch';
  if (typeof parsed.summary !== 'string' || parsed.summary.length < 20) return 'summary-weak';
  if (!Array.isArray(parsed.anchors) || parsed.anchors.length === 0 || parsed.anchors.some((anchor) => typeof anchor !== 'string' || !anchor.trim())) return 'anchors-missing';
  return null;
}

export function collectContext(input, cwd = process.cwd()) {
  const file = input?.tool_input?.file_path || input?.tool_input?.file || '';
  if (typeof file !== 'string' || !file) return { relevant: false };
  const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
  const absolute = path.resolve(root, file);
  if (!within(root, absolute)) return { relevant: false };
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (!relative.startsWith('.youdede/phases/')) return { relevant: false };
  const match = EVIDENCE_PATTERN.exec(relative);
  // Every other name in the reserved directory (notes.md, spec2.json, sub/design.json) is unknown.
  if (!match) return { relevant: true, phase: relative.slice('.youdede/phases/'.length) };
  const context = { relevant: true, phase: match[1], relative, inspectionError: null, proposed: '', complete: true, predecessorRaw: null, predecessorError: null };
  try {
    const canonicalRoot = realpathSync(root);
    const evidenceDir = path.join(canonicalRoot, '.youdede', 'phases');
    if (existsSync(evidenceDir)) {
      const realDir = realpathSync(evidenceDir);
      if (!within(canonicalRoot, realDir)) return { relevant: true, inspectionError: 'evidence-dir-escape' };
    }
    if (existsSync(absolute)) {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) return { relevant: true, inspectionError: 'unsafe-target' };
      context.before = readFileSync(absolute, 'utf8');
    }
    const rebuilt = rebuildProposed(input, context.before || '');
    context.complete = rebuilt.complete;
    context.proposed = rebuilt.proposed;
    const index = PHASES.indexOf(context.phase);
    if (index > 0) {
      const predecessor = path.join(canonicalRoot, '.youdede', 'phases', `${PHASES[index - 1]}.json`);
      if (!existsSync(predecessor)) {
        context.predecessorError = 'missing';
      } else {
        const stat = lstatSync(predecessor);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) {
          context.predecessorError = 'unsafe';
        } else {
          context.predecessorRaw = readFileSync(predecessor, 'utf8');
        }
      }
    }
    return context;
  } catch {
    return { relevant: true, inspectionError: 'read-failed' };
  }
}

export function evaluate(context) {
  if (!context?.relevant) return allow();
  if (context.inspectionError) return block('inspection-failed', 'the phase evidence path could not be inspected safely; nothing was written');
  if (!PHASES.includes(context.phase)) return block('unknown-phase', `'.youdede/phases/' is reserved for the phase chain: ${PHASES.join(', ')}`);
  if (!context.complete) return block('revision-incomplete', 'the proposed evidence revision could not be reconstructed; write the full file instead');
  const ownError = evidenceError(context.proposed, context.phase);
  if (ownError) return block('malformed-evidence', `evidence must be a JSON object with matching phase, a summary of at least 20 characters, and non-empty anchors (${ownError})`);
  const index = PHASES.indexOf(context.phase);
  if (index === 0) return allow();
  if (context.predecessorError === 'missing') return block('predecessor-missing', `'${context.phase}' requires a valid '${PHASES[index - 1]}.json' evidence file first`);
  if (context.predecessorError) return block('predecessor-unsafe', 'the predecessor evidence file could not be inspected safely');
  const predecessorError = evidenceError(context.predecessorRaw, PHASES[index - 1]);
  if (predecessorError) return block('predecessor-invalid', `the '${PHASES[index - 1]}' evidence is not valid (${predecessorError}); repair it before advancing`);
  return allow();
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error('stdin-limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const decision = evaluate(collectContext(input));
    if (decision.exitCode !== 0) process.stderr.write(`${decision.message}\n`);
    process.exit(decision.exitCode);
  } catch (error) {
    process.stderr.write(`BLOCKED by phase-gate-guard [input-unreadable]: the hook input could not be inspected (${error.message}).\n`);
    process.exit(2);
  }
}
