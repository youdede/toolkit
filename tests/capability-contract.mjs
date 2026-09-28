// T7: validation of hook capability declarations and of the intent records that sequence checks
// return. Used by the capability tests; nothing here ships in a payload.

import { commandKey } from '../scripts/lib/shared-hook/shell-items.mjs';
import { CLI_OPTIONS } from './cli-options.mjs';

const STEP = (entry) => typeof entry === 'string' && entry.length > 0;
const isList = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
// A family whose path words say nothing (an empty path, or only `*` steps).
export const emptyPath = (family) => (family.paths ?? [[]]).every((path) => path.every((step) => step === '*'));

// Problems of one declaration: schema, named checks, the evidence rule for empty-path families (M1b),
// and fixture membership of `values`, `flags`, and `safe.on` (M7).
export function validateCapability(cap, fixture = CLI_OPTIONS) {
  const problems = [];
  const where = (index, text) => problems.push(`${cap.hook ?? '?'} families[${index}]: ${text}`);
  if (typeof cap.hook !== 'string' || !/^[a-z0-9-]+$/.test(cap.hook)) problems.push('hook must be a slug');
  if (typeof cap.uninspectable !== 'string' || !/^[a-z0-9-]+$/.test(cap.uninspectable)) problems.push(`${cap.hook}: uninspectable must be a rule id`);
  if (!isList(cap.visible ?? [])) problems.push(`${cap.hook}: visible must list phrases`);
  const allowed = new Set(['hook', 'uninspectable', 'visible', 'families', 'commands', 'sequence', 'unseen', 'runners', 'checks']);
  for (const key of Object.keys(cap)) if (!allowed.has(key)) problems.push(`${cap.hook}: unknown key ${key}`);
  for (const name of ['commands', 'sequence', 'unseen']) {
    if (cap[name] !== undefined && typeof cap.checks?.[cap[name]] !== 'function') problems.push(`${cap.hook}: ${name} check ${cap[name]} does not exist`);
  }
  if (cap.runners !== undefined && typeof cap.runners !== 'boolean') problems.push(`${cap.hook}: runners must be a boolean`);
  for (const [index, family] of (cap.families ?? []).entries()) {
    const familyKeys = new Set(['executables', 'paths', 'values', 'flags', 'safe', 'decisive', 'evidence', 'evidenceNone', 'rule', 'check']);
    for (const key of Object.keys(family)) if (!familyKeys.has(key)) where(index, `unknown key ${key}`);
    if (!isList(family.executables) || !family.executables.length) where(index, 'executables must list command names');
    else for (const name of family.executables) if (commandKey(name) !== name) where(index, `executable ${name} is not a command key (${commandKey(name)})`);
    if (!Array.isArray(family.paths) || !family.paths.length) where(index, 'paths must list paths');
    else for (const path of family.paths) {
      if (!Array.isArray(path) || path.length > 8) where(index, 'a path is an array of at most 8 steps');
      else for (const step of path) if (!(STEP(step) || (Array.isArray(step) && step.length && step.every(STEP)))) where(index, `bad step ${JSON.stringify(step)}`);
    }
    if ((family.rule === undefined) === (family.check === undefined)) where(index, 'exactly one of rule and check');
    if (family.check !== undefined && typeof cap.checks?.[family.check] !== 'function') where(index, `check ${family.check} does not exist`);
    if (family.rule !== undefined && !/^[a-z0-9-]+$/.test(family.rule)) where(index, 'rule must be a rule id');
    for (const name of ['values', 'flags', 'decisive']) if (family[name] !== undefined && !isList(family[name])) where(index, `${name} must list option spellings`);
    for (const mode of family.safe ?? []) if (!isList(mode.on) || !isList(mode.off) || !mode.on.length) where(index, 'a safe mode lists on (not empty) and off spellings');
    for (const entry of family.evidence ?? []) {
      const ok = (part) => STEP(part) || part instanceof RegExp;
      if (!(ok(entry) || (Array.isArray(entry) && entry.length > 1 && entry.every(ok)))) where(index, `bad evidence ${String(entry)}`);
    }
    // Decisive options are evidence too (M1b); without them an empty-path family decides explicitly.
    if (emptyPath(family) && family.check !== undefined && !family.decisive?.length) {
      if (!Array.isArray(family.evidence)) where(index, 'an empty-path family with a check must declare evidence');
      else if (!family.evidence.length && !(typeof family.evidenceNone === 'string' && family.evidenceNone.trim())) where(index, 'evidence: [] needs evidenceNone');
    }
    if (family.evidenceNone !== undefined && family.evidence?.length) where(index, 'evidenceNone only goes with evidence: []');
    // M7: a wrong value or flag entry can hide a verb; each must be verified for every executable.
    const verified = [['values', family.values], ['flags', family.flags], ['safe', (family.safe ?? []).flatMap((mode) => mode.on)]];
    for (const [kind, list] of verified) {
      for (const option of list ?? []) {
        for (const name of family.executables ?? []) {
          if (!fixture[name]?.[kind]?.includes(option)) where(index, `${kind} ${option} of ${name} is not in the CLI option fixture`);
        }
      }
    }
  }
  return problems;
}

// Intent records (capabilities.md C): the only non-three-value returns of a sequence check.
const oneOf = (value, list) => list.includes(value);
const bool = (value) => typeof value === 'boolean';
export const INTENT_SHAPES = {
  CommitIntent: (record) => bool(record.found) && bool(record.uninspectable) && oneOf(record.unsupported, [null, 'force-add', 'alias-definition', 'shell-alias', 'alias-chain'])
    && bool(record.scopeChanged) && bool(record.worktree) && bool(record.noVerify) && Object.keys(record).length === 6,
  SigningIntent: (record) => Array.isArray(record.states) && record.states.every((state) => oneOf(state, ['explicit', 'disabled', 'default'])) && bool(record.scoped) && Object.keys(record).length === 2,
  CommitPlan: (record) => oneOf(record.kind, ['none', 'staged', 'worktree', 'invalid']) && bool(record.untracked) && Object.keys(record).length === 2,
  ReleasePlan: (record) => oneOf(record.intent, ['none', 'release', 'invalid'])
    && (record.manager === undefined || oneOf(record.manager, ['npm', 'pnpm', 'yarn', 'cargo', 'bun', 'python', 'github', 'mobile']))
    && (record.platforms === undefined || (Array.isArray(record.platforms) && record.platforms.every((platform) => oneOf(platform, ['ios', 'android']))))
    && Array.isArray(record.directories) && record.directories.every((entry) => typeof entry === 'string')
    && Object.keys(record).every((key) => ['intent', 'manager', 'platforms', 'directories'].includes(key))
};
export function validIntent(type, record) {
  return Boolean(record) && typeof record === 'object' && INTENT_SHAPES[type](record);
}
