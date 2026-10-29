// Capability matcher for Youdede Bash hooks (shared block `capability`, which needs the `shell-items`
// block). A hook declares the commands it protects as data (`CAPABILITY`: families of executables,
// paths, options, safe modes, checks), and this module answers, per hook, a concrete rule id, U
// (uninspectable), or NOT_MINE. Edit it here and run `npm run shared-hooks`;
// tests/shared-hook-capability.test.mjs holds its rules. Every loop is linear in the words, or bounded by
// the path length and the number of safe modes.
import { commandKey, parseShell } from './shell-items.mjs';

export const NOT_MINE = null;
export const U = 'U';

// Precedence: a concrete rule beats U, which beats NOT_MINE.
const rank = (verdict) => (verdict === NOT_MINE ? 0 : verdict === U ? 1 : 2);
export function strongest(...verdicts) {
  let best = NOT_MINE;
  for (const verdict of verdicts) if (rank(verdict) > rank(best)) best = verdict;
  return best;
}

export const isStatic = (word) => word?.kind === 'static';
export const staticText = (word) => (isStatic(word) ? word.text : null);
// A literal character: a static or opaque word, or a pattern with a literal or bracket part.
export const hasLiteral = (word) => Boolean(word) && (word.kind !== 'pattern' || word.parts.some((part) => part.lit !== undefined || part.set));

// M6. canMatch(word, literal, mode): can the word spell `literal` (`exact`), a string that starts with
// it (`prefix`), or one that ends with it (`suffix`)? Case-insensitive. A glob part (`*`, `?`, `[…]`)
// never produces `/`; an expansion part produces anything; an opaque word matches everything.
// Linear in parts x characters.
function partAccepts(part, character) {
  if (part.lit !== undefined) return part.lit.toLowerCase() === character;
  if (character === '/') return false;
  if (part.one) return true;
  const codes = [character.codePointAt(0), character.toUpperCase().codePointAt(0)];
  const inside = codes.some((code) => part.set.some(([low, high]) => code >= low && code <= high));
  return part.negated ? !inside : inside;
}
export function canMatch(word, literal, mode = 'exact') {
  if (!word) return false;
  const target = String(literal).toLowerCase();
  if (word.kind === 'opaque') return true;
  if (word.kind === 'static') {
    const text = word.text.toLowerCase();
    return mode === 'prefix' ? text.startsWith(target) : mode === 'suffix' ? text.endsWith(target) : text === target;
  }
  // A run of wildcard parts matches what its widest part matches; merging keeps the walk linear.
  let parts = [];
  for (const part of word.parts) {
    if (part.any && parts.at(-1)?.any) { if (part.any === 'expansion') parts[parts.length - 1] = part; } else parts.push(part);
  }
  let characters = [...target];
  if (mode === 'suffix') { parts = [...parts].reverse(); characters = characters.reverse(); }
  // States are part indexes; a wildcard part (`any`) may match nothing or repeat.
  const close = (states) => {
    for (const state of [...states]) for (let next = state; next < parts.length && parts[next].any; next += 1) states.add(next + 1);
    return states;
  };
  let states = close(new Set([0]));
  for (const character of characters) {
    const next = new Set();
    for (const state of states) {
      const part = parts[state];
      if (!part) continue;
      if (part.any) { if (part.any === 'expansion' || character !== '/') next.add(state); }
      else if (partAccepts(part, character)) next.add(state + 1);
    }
    states = close(next);
    if (!states.size) return false;
  }
  return mode === 'exact' ? states.has(parts.length) : states.size > 0;
}

// A declared spelling: 'word' (exact), 'pre*' (prefix), '*suf' (suffix), '*' (any word), or a RegExp
// tested on static words only.
function spelling(entry) {
  if (entry instanceof RegExp) return { regex: entry };
  if (entry === '*') return { any: true };
  if (entry.length > 1 && entry.endsWith('*')) return { text: entry.slice(0, -1), mode: 'prefix' };
  if (entry.length > 1 && entry.startsWith('*')) return { text: entry.slice(1), mode: 'suffix' };
  return { text: entry, mode: 'exact' };
}
// 'yes' when a static word has the spelling, 'maybe' when another word can have it, 'no' otherwise.
export function wordMatches(word, entry) {
  const form = spelling(entry);
  if (form.any) return 'yes';
  if (form.regex) return isStatic(word) && form.regex.test(word.text) ? 'yes' : 'no';
  if (!canMatch(word, form.text, form.mode)) return 'no';
  return isStatic(word) ? 'yes' : 'maybe';
}
function stepMatches(word, step) {
  let best = 'no';
  for (const entry of [].concat(step)) {
    const result = wordMatches(word, entry);
    if (result === 'yes') return 'yes';
    if (result === 'maybe') best = 'maybe';
  }
  return best;
}

// npm runs a command from any unique abbreviation of a command or alias, and from its camelCase form
// (`npm pu` publishes). Source: npm 11.19.0, lib/utils/cmd-list.js (`commands`, `aliases`, `deref`) and
// abbrev 4.0.0, checked with `npm pu --help`; tests/shared-hook-capability.test.mjs compares npmCommand
// with the installed npm's deref. pnpm does not abbreviate (`pnpm pu` fails), and Yarn 1.22 runs `yarn pu`
// as the script or binary `pu`, so only npm gets these spellings.
export const NPM_COMMANDS = ['access', 'adduser', 'approve-scripts', 'audit', 'bugs', 'cache', 'ci', 'completion', 'config', 'dedupe',
  'deny-scripts', 'deprecate', 'diff', 'dist-tag', 'docs', 'doctor', 'edit', 'exec', 'explain', 'explore', 'find-dupes', 'fund', 'get',
  'help', 'help-search', 'init', 'install', 'install-ci-test', 'install-scripts', 'install-test', 'link', 'll', 'login', 'logout', 'ls',
  'org', 'outdated', 'owner', 'pack', 'ping', 'pkg', 'prefix', 'profile', 'prune', 'publish', 'query', 'rebuild', 'repo', 'restart',
  'root', 'run', 'sbom', 'search', 'set', 'shrinkwrap', 'stage', 'star', 'stars', 'start', 'stop', 'team', 'test', 'token', 'trust',
  'undeprecate', 'uninstall', 'unpublish', 'unstar', 'update', 'version', 'view', 'whoami'];
export const NPM_ALIASES = {
  author: 'owner', home: 'docs', issues: 'bugs', info: 'view', show: 'view', find: 'search', add: 'install', unlink: 'uninstall',
  remove: 'uninstall', rm: 'uninstall', r: 'uninstall', un: 'uninstall', rb: 'rebuild', list: 'ls', ln: 'link', create: 'init',
  i: 'install', it: 'install-test', cit: 'install-ci-test', u: 'update', up: 'update', c: 'config', s: 'search', se: 'search',
  tst: 'test', t: 'test', ddp: 'dedupe', v: 'view', 'run-script': 'run', 'clean-install': 'ci', 'clean-install-test': 'install-ci-test',
  x: 'exec', why: 'explain', la: 'll', verison: 'version', ic: 'ci', innit: 'init', in: 'install', ins: 'install', inst: 'install',
  insta: 'install', instal: 'install', isnt: 'install', isnta: 'install', isntal: 'install', isntall: 'install', 'install-clean': 'ci',
  'isntall-clean': 'ci', hlep: 'help', 'dist-tags': 'dist-tag', upgrade: 'update', udpate: 'update', rum: 'run', sit: 'install-ci-test',
  urn: 'run', ogr: 'org', 'add-user': 'adduser'
};
// abbrev 4.0.0: every prefix of a word that no neighbouring word (in sorted order) shares.
function abbreviations(words) {
  const list = [...words].sort((a, b) => (a === b ? 0 : a > b ? 1 : -1));
  const map = new Map();
  let prev = '';
  for (let index = 0; index < list.length; index += 1) {
    const current = list[index];
    const next = list[index + 1] || '';
    if (current === next) continue;
    let [nextMatches, prevMatches, j] = [true, true, 0];
    for (; j < current.length; j += 1) {
      nextMatches = nextMatches && current[j] === next[j];
      prevMatches = prevMatches && current[j] === prev[j];
      if (!nextMatches && !prevMatches) { j += 1; break; }
    }
    prev = current;
    if (j === current.length) { map.set(current, current); continue; }
    for (let a = current.slice(0, j); j <= current.length; j += 1) { map.set(a, current); a += current.charAt(j); }
  }
  return map;
}
let npmAbbreviations = null;
// The npm command a word runs, as npm's deref resolves it, or undefined.
export function npmCommand(text) {
  if (!text) return undefined;
  let word = /[A-Z]/.test(text) ? text.replace(/([A-Z])/g, (letter) => `-${letter.toLowerCase()}`) : text;
  if (NPM_COMMANDS.includes(word)) return word;
  if (Object.hasOwn(NPM_ALIASES, word)) return NPM_ALIASES[word];
  npmAbbreviations ??= abbreviations([...NPM_COMMANDS, ...Object.keys(NPM_ALIASES)]);
  word = npmAbbreviations.get(word);
  while (word !== undefined && Object.hasOwn(NPM_ALIASES, word)) word = NPM_ALIASES[word];
  return word;
}
// Every word npm resolves to the same command as `text`: the prefixes of every command and alias, and
// their camelCase forms, kept when they resolve to it. `text` itself stays (older npm commands).
const npmSpellingCache = new Map();
export function npmSpellings(text) {
  if (npmSpellingCache.has(text)) return npmSpellingCache.get(text);
  const target = npmCommand(text);
  const spellings = new Set([text]);
  if (target !== undefined) {
    for (const word of [...NPM_COMMANDS, ...Object.keys(NPM_ALIASES)]) {
      for (let end = 1; end <= word.length; end += 1) {
        const prefix = word.slice(0, end);
        for (const candidate of [prefix, prefix.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]) {
          if (npmCommand(candidate) === target) spellings.add(candidate);
        }
      }
    }
  }
  const list = [...spellings].sort();
  npmSpellingCache.set(text, list);
  return list;
}
// A path whose first step, an npm command, also takes every spelling npm resolves to it.
const npmPaths = new WeakMap();
function npmPath(path) {
  if (!path.length || path[0] === '*') return path;
  if (!npmPaths.has(path)) {
    const first = [].concat(path[0]).flatMap((entry) => (typeof entry === 'string' && spelling(entry).mode === 'exact' ? npmSpellings(entry) : [entry]));
    npmPaths.set(path, [first, ...path.slice(1)]);
  }
  return npmPaths.get(path);
}

export const isOptionWord = (word) => isStatic(word) && word.text.startsWith('-') && word.text !== '-' && word.text !== '--';
const listed = (list, text) => (list ?? []).some((entry) => {
  if (entry instanceof RegExp) return entry.test(text);
  const form = spelling(entry);
  return form.mode === 'prefix' ? text.startsWith(form.text) : form.mode === 'suffix' ? text.endsWith(form.text) : text === form.text;
});

// M2, M3, M4. Walks the readings of the words for one path. An option with `=` stands alone, one in
// `values` takes the next word, one in `flags` takes nothing, and any other option is read both ways.
// `--` ends options: later words are operands only. An operand fills the next path step (M3); a word
// that may split into several words, at a step with steps left, may fill the rest of the path (M3b).
// Each safe mode is 0 (off), 1 (on), or 2 (on, but a later non-static word might undo it) (M4). A
// non-static word before `--` may also be an option that takes the next word: that reading is
// `dynamic` and never gives a concrete rule. Readings are merged per word index on their state, so the
// walk is linear in the words; each final reading keeps its roles as a linked list.
function walk(words, family, path) {
  const modes = family.safe ?? [];
  const could = (word, mode) => [...mode.on, ...mode.off].some((entry) => canMatch(word, entry)
    || (entry.includes('=') && canMatch(word, `${entry.slice(0, entry.indexOf('='))}=`, 'prefix')));
  const signature = (state) => `${state.step}|${state.maybe ? 1 : 0}${state.evidence ? 1 : 0}${state.ended ? 1 : 0}${state.dynamic ? 1 : 0}|${state.safe.join('')}`;
  const buckets = Array.from({ length: words.length }, () => new Map());
  const finals = [];
  const push = (state) => {
    if (!state) return;
    if (state.index >= words.length) finals.push(state);
    else if (!buckets[state.index].has(signature(state))) buckets[state.index].set(signature(state), state);
  };
  push({ index: 0, step: 0, maybe: false, evidence: false, ended: false, dynamic: false, safe: modes.map(() => 0), roles: null });
  if (!words.length) return finals;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    for (const state of buckets[index].values()) {
      const role = (kind) => ({ kind, index, prev: state.roles });
      const valued = (changes) => ({ ...state, ...changes, index: index + 2, roles: { kind: 'value', index: index + 1, prev: role('option') } });
      if (state.ended) { push(fill(state, word, path, role('after'))); continue; }
      if (isStatic(word) && word.text === '--') { push({ ...state, index: index + 1, ended: true, roles: role('terminator') }); continue; }
      if (isOptionWord(word)) {
        const text = word.text;
        const safe = state.safe.map((value, position) => (modes[position].on.includes(text) ? 1 : modes[position].off.includes(text) ? 0 : value));
        const alone = { ...state, safe, index: index + 1, roles: role('option') };
        const last = index + 1 >= words.length;
        if (text.includes('=') || listed(family.flags, text) || last) push(alone);
        else if (listed(family.values, text)) push(valued({ safe }));
        else { push(alone); push(valued({ safe })); }
        continue;
      }
      if (!isStatic(word)) {
        const safe = state.safe.map((value, position) => (value === 1 && could(word, modes[position]) ? 2 : value));
        push(fill({ ...state, safe }, word, path, role('operand')));
        if (index + 1 < words.length) push(valued({ safe, dynamic: true }));
        continue;
      }
      push(fill(state, word, path, role('operand')));
    }
    buckets[index] = null;
  }
  return finals;
}

// An operand: fills the next path step, or is a later operand; null when the path cannot be taken.
function fill(state, word, path, roles) {
  const next = { ...state, index: state.index + 1, roles };
  if (state.step >= path.length) return next;
  const step = path[state.step];
  if (word.splits && !isStatic(word) && state.step < path.length - 1) return { ...next, maybe: true, step: path.length };
  const result = step === '*' ? 'yes' : stepMatches(word, step);
  if (result === 'no') return null;
  return { ...next, step: state.step + 1, maybe: state.maybe || result === 'maybe', evidence: state.evidence || (step !== '*' && hasLiteral(word)) };
}

// The words with the npm command (the operand that filled the first path step) replaced by the declared
// spelling it resolves to, or the words themselves.
function declaredSpelling(words, roles, path) {
  let first = null;
  for (let cell = roles; cell; cell = cell.prev) if (cell.kind === 'operand' || cell.kind === 'after') first = cell;
  const word = first && words[first.index];
  if (!path.length || !isStatic(word)) return words;
  const target = npmCommand(word.text);
  const entry = [].concat(path[0]).find((candidate) => typeof candidate === 'string' && (candidate === word.text || (target !== undefined && npmCommand(candidate) === target)));
  if (!entry || entry === word.text) return words;
  const copy = [...words];
  copy[first.index] = { ...word, text: entry };
  return copy;
}

// The reading of a final state: options (with the value each takes), operands, and the words after `--`.
function readingOf(words, roles) {
  const cells = [];
  for (let cell = roles; cell; cell = cell.prev) cells.push(cell);
  const reading = { positionals: [], options: [], afterTerminator: [] };
  for (const cell of cells.reverse()) {
    const word = words[cell.index];
    if (cell.kind === 'option') reading.options.push({ word, index: cell.index });
    else if (cell.kind === 'value') reading.options.at(-1).value = word;
    else if (cell.kind === 'operand') reading.positionals.push(word);
    else if (cell.kind === 'after') { reading.positionals.push(word); reading.afterTerminator.push(word); }
  }
  return reading;
}

// The reading where unknown options take no value, for a view that follows no family.
export function plainReading(words, values = []) {
  const reading = { positionals: [], options: [], afterTerminator: [] };
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (isStatic(word) && word.text === '--') {
      for (const rest of words.slice(index + 1)) { reading.positionals.push(rest); reading.afterTerminator.push(rest); }
      break;
    }
    if (!isOptionWord(word)) { reading.positionals.push(word); continue; }
    const option = { word, index };
    if (!word.text.includes('=') && listed(values, word.text) && index + 1 < words.length) option.value = words[++index];
    reading.options.push(option);
  }
  return reading;
}

// M1b evidence: a word with a literal character that matches an `evidence` or `decisive` entry; an
// array entry needs each of its spellings on a different word.
function hasEvidence(words, family) {
  const candidates = words.filter(hasLiteral);
  const find = (entry, used) => candidates.findIndex((word, index) => !used.has(index) && wordMatches(word, entry) !== 'no');
  for (const entry of [...(family.evidence ?? []), ...(family.decisive ?? [])]) {
    const used = new Set();
    if ([].concat(entry).every((part) => { const found = find(part, used); used.add(found); return found >= 0; })) return true;
  }
  return false;
}

// M5: a non-static word in a possible option role (not after `--`, not a value) that can spell a
// decisive option or `option=`, or a non-static value of a decisive option.
function decisiveUnknown(reading, words, family) {
  const decisive = (family.decisive ?? []).filter((entry) => typeof entry === 'string');
  if (!decisive.length) return false;
  const excluded = new Set([...reading.afterTerminator, ...reading.options.map((option) => option.value).filter(Boolean)]);
  const spells = (word) => decisive.some((entry) => canMatch(word, entry) || canMatch(word, `${entry.split('=')[0]}=`, 'prefix'));
  if (words.some((word) => !isStatic(word) && !excluded.has(word) && spells(word))) return true;
  return reading.options.some((option) => option.value && !isStatic(option.value) && decisive.includes(option.word.text));
}

// One family for a command whose executable is the family's. `taken` marks a pattern or opaque
// executable ('literal', or 'evidence' when it has no literal character): it never gives a concrete
// rule, and without a literal it needs evidence. Readings and paths combine by precedence.
function judgeFamily(view, family, cap, taken, npm) {
  const words = view.words;
  let best = NOT_MINE;
  const paths = family.paths?.length ? family.paths : [[]];
  for (const [pathIndex, declared] of paths.entries()) {
    const path = npm ? npmPath(declared) : declared;
    for (const state of walk(words, family, path)) {
      if (state.step !== path.length) continue;
      if (taken === 'evidence' && !state.evidence && !hasEvidence(words, family)) continue;
      if (state.safe.includes(1)) continue;
      let verdict = U;
      if (!state.maybe && !state.safe.includes(2)) {
        // A check reads the npm command as declared (`npm rum dev` as `npm run dev`).
        const checkedWords = npm ? declaredSpelling(words, state.roles, declared) : words;
        const reading = readingOf(checkedWords, state.roles);
        const checked = family.check ? cap.checks[family.check]({ ...view, words: checkedWords, reading, pathIndex, pathLength: path.length }) : family.rule;
        verdict = strongest(checked, decisiveUnknown(reading, words, family) ? U : NOT_MINE);
        if (verdict !== NOT_MINE && (taken || state.dynamic)) verdict = U;
      }
      best = strongest(best, verdict);
      if (rank(best) === 2) return best;
    }
  }
  return best;
}

// The key part of a pattern executable: after its last literal `/`, cut at its first literal `.`,
// without trailing literal digits.
function executableKeyWord(exe) {
  let parts = exe.parts;
  const slash = parts.findLastIndex((part) => part.lit === '/' || part.lit === '\\');
  if (slash >= 0) parts = parts.slice(slash + 1);
  const dot = parts.findIndex((part) => part.lit === '.');
  if (dot > 0) parts = parts.slice(0, dot);
  while (parts.length > 1 && /\d/.test(parts.at(-1).lit ?? '')) parts = parts.slice(0, -1);
  return { ...exe, parts };
}

// Runners: the command a package runner starts, after the runner's options and its
// verb (`npx`, `bunx`, `pnpx`, `pnpm [exec|dlx]`, `yarn [dlx|exec]`, `bun run|x`, `npm exec|x`,
// `bundle exec`, `uv run`, `poetry run`). pnpm and Yarn also run a package binary without a verb. The
// runner's last option may take the next word, so that word and the one after it are both read as
// the command.
const RUNNERS = { npx: null, bunx: null, pnpx: null, pnpm: ['exec', 'dlx'], yarn: ['dlx', 'exec'], bun: ['run', 'x'], npm: ['exec', 'x'], bundle: ['exec'], uv: ['run'], poetry: ['run'] };
const OPTIONAL_VERB = new Set(['pnpm', 'yarn']);
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'bun', 'npm']);
function runnerViews(view) {
  const verbs = RUNNERS[view.key];
  if (verbs === undefined) return [];
  const words = view.words;
  let index = 0;
  const skipOptions = () => { while (index < words.length && (isOptionWord(words[index]) || staticText(words[index]) === '--')) index += 1; };
  skipOptions();
  if (verbs) {
    const verb = staticText(words[index]);
    if (verbs.includes(verb) || (view.key === 'npm' && npmCommand(verb) === 'exec')) { index += 1; skipOptions(); }
    else if (!OPTIONAL_VERB.has(view.key)) return [];
  }
  const starts = [index];
  const previous = words[index - 1];
  if (isOptionWord(previous) && !previous.text.includes('=') && index + 1 < words.length) starts.push(index + 1);
  return starts.filter((start) => start < words.length).map((start) => {
    // A package runner names a package spec, whose binary is the package name without its version
    // (`npx npm@10`, `pnpm dlx @scope/tool@1`).
    const word = words[start];
    const exe = isStatic(word) && PACKAGE_RUNNERS.has(view.key) ? { ...word, text: word.text.replace(/(?<=.)@[^@/]*$/, '') } : word;
    return { ...view, exe, key: isStatic(exe) ? commandKey(exe.text) : null, words: words.slice(start + 1) };
  });
}

// M1. A static executable selects the families that name its key. A pattern or opaque executable is a
// candidate of a family when its key can spell one of the family's executables. A hook with
// `runners: true` also judges the command a runner starts.
export function judgeCommand(view, cap) {
  const best = cap.commands ? strongest(cap.checks[cap.commands](view)) : NOT_MINE;
  if (rank(best) === 2 || !view.exe) return best;
  return strongest(best, judgeFamilies(view, cap, 0));
}
const RUNNER_DEPTH = 4;
function judgeFamilies(view, cap, depth) {
  let best = NOT_MINE;
  const exe = view.exe;
  const key = isStatic(exe) ? commandKey(exe.text) : null;
  const base = exe.kind === 'pattern' ? executableKeyWord(exe) : exe;
  for (const family of cap.families ?? []) {
    const names = family.executables.map(commandKey);
    let taken = false;
    if (key !== null) { if (!names.includes(key)) continue; }
    else if (!names.some((name) => canMatch(base, name))) continue;
    else taken = hasLiteral(base) ? 'literal' : 'evidence';
    // An executable that is (or can spell) npm reads the family's npm commands as npm resolves them.
    const npm = names.includes('npm') && (key === 'npm' || (key === null && canMatch(base, 'npm')));
    best = strongest(best, judgeFamily(view, family, cap, taken, npm));
    if (rank(best) === 2) return best;
  }
  if (!cap.runners || depth >= RUNNER_DEPTH) return best;
  for (const inner of runnerViews(view)) {
    best = strongest(best, judgeFamilies(inner, cap, depth + 1));
    if (rank(best) === 2) return best;
  }
  return best;
}

// A hook's visible phrases, word-bounded and case-insensitive, in an unseen program's text.
export function mentions(cap, text) {
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return (cap.visible ?? []).some((phrase) => new RegExp(`${/^\w/.test(phrase) ? '(?<![\\w-])' : ''}${escape(phrase)}${/\w$/.test(phrase) ? '(?![\\w-])' : ''}`, 'i').test(text));
}

// Items in order; the first one that is not NOT_MINE decides. A Limit is U. An Unseen program is the
// hook's `unseen` check's, or U when it mentions a visible phrase. A command whose executable is neither
// static nor literal, in a call that defines functions, is U when a function body concerns the hook.
// `options.inline` judges interpreter programs (inline.mjs) for the hooks that use it.
export function judgeItems(items, cap, options = {}) {
  const functions = items.functions ?? new Map();
  let bodies = null;
  for (const item of items) {
    let verdict = NOT_MINE;
    if (item.kind === 'limit') verdict = U;
    else if (item.kind === 'unseen') verdict = cap.unseen ? cap.checks[cap.unseen](item) : mentions(cap, item.text) ? U : NOT_MINE;
    else {
      verdict = judgeCommand(item, cap);
      if (verdict === NOT_MINE && options.inline) verdict = options.inline(item, cap);
      if (verdict === NOT_MINE && item.exe && !isStatic(item.exe) && !hasLiteral(item.exe) && functions.size) {
        bodies ??= [...functions.values()].some((body) => judgeItems(body, cap, options) !== NOT_MINE);
        if (bodies) verdict = U;
      }
    }
    if (verdict !== NOT_MINE) return verdict;
  }
  return NOT_MINE;
}

// The verdict of a hook's capability on a Bash command.
export function judge(command, cap, options = {}) {
  return judgeItems(parseShell(command), cap, options);
}
