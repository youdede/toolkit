import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ARTIFACTS_ROOT = path.join(ROOT, 'artifacts');
export const PACKS_ROOT = path.join(ROOT, 'packs');

const SKILL_VERBS = new Set([
  'assess', 'audit', 'author', 'build', 'capture', 'compose', 'compress', 'conduct', 'critique', 'debug',
  'decompose', 'define', 'delegate', 'deliver', 'design', 'document', 'edit', 'enforce', 'establish', 'evaluate',
  'execute', 'extract', 'frame', 'generate', 'govern', 'guide', 'implement', 'improve', 'interview', 'isolate',
  'keep', 'load', 'make', 'map', 'optimize', 'plan', 'prepare', 'produce', 'provision', 'publish', 'resume',
  'qualify', 'query', 'reconcile', 'reduce', 'request', 'research', 'resolve',
  'review', 'schedule', 'simplify', 'specify', 'structure', 'surface', 'sync', 'synthesize', 'teach', 'test', 'triage', 'verify', 'write'
]);
const SUBAGENT_ROLES = new Set([
  'analyst', 'auditor', 'diagnostician', 'mapper', 'planner', 'researcher',
  'reviewer', 'specialist', 'tester', 'verifier'
]);
const MAX_PACK_HOOK_FANOUT = 3;
const ARTIFACT_RELATIONSHIP_KEYS = ['composesWith', 'conflictsWith', 'supersedes', 'prerequisites'];
const KIND_PLURALS = Object.freeze({
  skill: 'skills',
  hook: 'hooks',
  subagent: 'subagents',
  command: 'commands',
  context: 'contexts',
  'mcp-server': 'mcp-servers'
});
const PACK_ROLE_KINDS = {
  procedure: new Set(['skill']),
  collector: new Set(['skill', 'subagent']),
  specialist: new Set(['subagent']),
  verifier: new Set(['skill', 'subagent']),
  enforcement: new Set(['hook']),
  observer: new Set(['hook']),
  entrypoint: new Set(['command']),
  baseline: new Set(['context']),
  integration: new Set(['mcp-server'])
};
const SUPPORTED_HOOK_EVENTS = new Set([
  'SessionStart', 'Setup', 'InstructionsLoaded', 'UserPromptSubmit', 'UserPromptExpansion',
  'MessageDisplay', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
  'PostToolBatch', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop',
  'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure', 'TeammateIdle', 'ConfigChange',
  'CwdChanged', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'PostCompact',
  'SessionEnd', 'Elicitation', 'ElicitationResult'
]);
const MATCHER_HOOK_EVENTS = new Set([
  'SessionStart', 'Setup', 'InstructionsLoaded', 'UserPromptExpansion', 'PreToolUse',
  'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'Notification',
  'SubagentStart', 'SubagentStop', 'StopFailure', 'ConfigChange', 'FileChanged', 'PreCompact',
  'PostCompact', 'SessionEnd', 'Elicitation', 'ElicitationResult'
]);

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${path.relative(ROOT, file)}: ${error.message}`);
  }
}

function walk(directory, name, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, name, output);
    else if (entry.name === name) output.push(absolute);
  }
  return output;
}

export function loadArtifacts(root = ROOT) {
  const artifactRoot = path.join(root, 'artifacts');
  if (!existsSync(artifactRoot)) return [];
  return walk(artifactRoot, 'artifact.json')
    .sort()
    .map((manifestPath) => {
      const directory = path.dirname(manifestPath);
      const manifest = readJson(manifestPath);
      const adapters = {};
      for (const [target, relative] of Object.entries(manifest.adapters || {})) {
        const adapterPath = path.resolve(directory, relative);
        adapters[target] = { path: adapterPath, data: readJson(adapterPath) };
      }
      return { root, directory, manifestPath, manifest, adapters };
    });
}

export function loadPacks(root = ROOT) {
  const packsRoot = path.join(root, 'packs');
  if (!existsSync(packsRoot)) return [];
  return walk(packsRoot, 'pack.json')
    .sort()
    .map((manifestPath) => ({
      directory: path.dirname(manifestPath),
      manifestPath,
      manifest: readJson(manifestPath)
    }));
}

export function resolvePack(query, root = ROOT) {
  const matches = loadPacks(root).filter(({ manifest }) => manifest.id === query || manifest.slug === query);
  if (matches.length === 0) throw new Error(`pack '${query}' was not found`);
  if (matches.length > 1) throw new Error(`pack slug '${query}' is ambiguous; use a full id`);
  return matches[0];
}

export function loadTaxonomy(root = ROOT) {
  return readJson(path.join(root, 'catalog', 'taxonomy.json'));
}

export function hookBindings(adapter) {
  if (!adapter) return [];
  if (Array.isArray(adapter.bindings)) return adapter.bindings;
  return Object.entries(adapter.settingsPatch?.hooks || {}).flatMap(([event, entries]) =>
    (entries || []).map((entry) => ({ event, matcher: entry.matcher || '' })));
}

function intersectSets(sets) {
  if (sets.length === 0) return new Set();
  return sets.slice(1).reduce(
    (common, current) => new Set([...common].filter((value) => current.has(value))),
    new Set(sets[0])
  );
}

function sameMembers(left, right) {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function uniquePairs(manifests, key) {
  const known = new Set(manifests.map((manifest) => manifest.id));
  const pairs = new Set();
  for (const manifest of manifests) {
    for (const relatedId of manifest.relationships?.[key] || []) {
      if (!known.has(relatedId)) continue;
      pairs.add([manifest.id, relatedId].sort().join('\0'));
    }
  }
  return pairs;
}

export function analyzeRelationshipGraph(artifacts) {
  const manifests = artifacts.map((record) => record.manifest);
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const directedEdges = Object.fromEntries([...ARTIFACT_RELATIONSHIP_KEYS, 'packIds']
    .map((key) => [key, manifests.reduce((count, manifest) => count + (manifest.relationships?.[key]?.length || 0), 0)]));
  const compositionPairs = uniquePairs(manifests, 'composesWith');
  const crossKindCompositionEdges = [...compositionPairs].filter((pair) => {
    const [left, right] = pair.split('\0');
    return byId.get(left)?.kind !== byId.get(right)?.kind;
  }).length;
  const orphanArtifactIds = manifests
    .filter((manifest) => [...ARTIFACT_RELATIONSHIP_KEYS, 'packIds']
      .every((key) => (manifest.relationships?.[key]?.length || 0) === 0))
    .map((manifest) => manifest.id)
    .sort();
  const orphanCountsByKind = Object.fromEntries(Object.keys(KIND_PLURALS).map((kind) => [
    kind,
    orphanArtifactIds.filter((id) => byId.get(id)?.kind === kind).length
  ]));

  return {
    counts: {
      artifactNodes: manifests.length,
      directedEdges,
      compositionEdges: compositionPairs.size,
      conflictEdges: uniquePairs(manifests, 'conflictsWith').size,
      crossKindCompositionEdges,
      orphanArtifacts: orphanArtifactIds.length
    },
    orphanCountsByKind,
    orphanArtifactIds
  };
}

function roleMatchesArtifact(role, artifact) {
  if (!artifact || !PACK_ROLE_KINDS[role]?.has(artifact.kind)) return false;
  if (role === 'enforcement') return artifact.operational?.behavior === 'enforcing';
  if (role === 'observer') return artifact.operational?.behavior === 'observing';
  return true;
}

export function analyzePackWorkflow(manifest, artifacts) {
  const members = Array.isArray(manifest.members) ? manifest.members : [];
  const byId = new Map(artifacts.map((record) => [record.manifest.id, record]));
  const entries = members.map((value) => {
    const member = value && typeof value === 'object' ? value : {};
    return { member, record: byId.get(member.artifactId) };
  });
  const required = entries.filter(({ member }) => member.required === true);
  const requiredIds = new Set(required.map(({ member }) => member.artifactId));
  const allIds = new Set(entries.map(({ member }) => member.artifactId));
  const requiredKinds = new Set(required.map(({ record }) => record?.manifest.kind).filter(Boolean));
  const roleCounts = Object.fromEntries(Object.keys(PACK_ROLE_KINDS).map((role) => [
    role,
    members.filter((member) => member.role === role).length
  ]));

  const knownEntries = entries.filter(({ record }) => record);
  const adjacency = new Map(knownEntries.map(({ member }) => [member.artifactId, new Set()]));
  for (const { member, record } of knownEntries) {
    for (const relatedId of record.manifest.relationships?.composesWith || []) {
      if (adjacency.has(relatedId)) adjacency.get(member.artifactId).add(relatedId);
    }
  }
  const visited = new Set();
  const firstId = knownEntries[0]?.member.artifactId;
  const queue = firstId ? [firstId] : [];
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const relatedId of adjacency.get(current) || []) if (!visited.has(relatedId)) queue.push(relatedId);
  }
  const compositionConnected = members.length >= 2
    && knownEntries.length === members.length
    && visited.size === members.length;

  const incompatiblePairs = [];
  for (let leftIndex = 0; leftIndex < knownEntries.length; leftIndex += 1) {
    const left = knownEntries[leftIndex].record.manifest;
    for (let rightIndex = leftIndex + 1; rightIndex < knownEntries.length; rightIndex += 1) {
      const right = knownEntries[rightIndex].record.manifest;
      if (left.relationships.conflictsWith.includes(right.id) || right.relationships.conflictsWith.includes(left.id)) {
        incompatiblePairs.push({ left: left.id, right: right.id, relationship: 'conflictsWith' });
      }
      if (left.relationships.supersedes.includes(right.id) || right.relationships.supersedes.includes(left.id)) {
        incompatiblePairs.push({ left: left.id, right: right.id, relationship: 'supersedes' });
      }
    }
  }

  const missingPrerequisites = required.flatMap(({ member, record }) => (record?.manifest.relationships?.prerequisites || [])
    .filter((prerequisiteId) => !requiredIds.has(prerequisiteId))
    .map((prerequisiteId) => ({ artifactId: member.artifactId, prerequisiteId })));

  const requiredRecordsComplete = required.length > 0 && required.every(({ record }) => record);
  const requiredTargetSets = required.map(({ record }) => new Set(Object.keys(record?.adapters || {})));
  const commonTargets = requiredRecordsComplete ? intersectSets(requiredTargetSets) : new Set();
  const compatibility = [...commonTargets].sort().flatMap((target) => {
    const commonScopes = intersectSets(required.map(({ record }) => new Set(record.adapters[target].data.scopes || [])));
    if (commonScopes.size === 0) return [];
    const scopes = [...commonScopes].sort();
    const optionalEntries = entries.filter(({ member }) => member.required !== true);
    const optionalUnsupportedByScope = Object.fromEntries(scopes.map((scope) => [
      scope,
      optionalEntries
        .filter(({ record }) => !record?.adapters[target]?.data.scopes?.includes(scope))
        .map(({ member }) => member.artifactId)
        .sort()
    ]));
    const optionalUnsupported = optionalEntries
      .filter(({ member }) => scopes.every((scope) => optionalUnsupportedByScope[scope].includes(member.artifactId)))
      .map(({ member }) => member.artifactId)
      .sort();
    return [{ target, scopes, optionalUnsupported, optionalUnsupportedByScope }];
  });

  const roleCompatible = knownEntries.length === members.length
    && knownEntries.every(({ member, record }) => roleMatchesArtifact(member.role, record.manifest));
  const criteria = {
    crossKindRequiredWorkflow: requiredKinds.size >= 2,
    requiredProcedure: required.some(({ member, record }) => member.role === 'procedure' && record?.manifest.kind === 'skill'),
    independentRequiredAssurance: required.some(({ member, record }) => ['specialist', 'verifier'].includes(member.role) && record?.manifest.kind === 'subagent'),
    roleCompatible,
    compositionConnected,
    conflictFree: incompatiblePairs.length === 0,
    prerequisiteClosed: missingPrerequisites.length === 0,
    compatibleInstallCoordinate: compatibility.length > 0
  };

  return {
    eligible: Object.values(criteria).every(Boolean),
    criteria,
    roleCounts,
    requiredKinds: [...requiredKinds].sort(),
    compatibility,
    incompatiblePairs,
    missingPrerequisites,
    memberIds: [...allIds].sort()
  };
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function parseFrontmatter(file) {
  const raw = readFileSync(file, 'utf8');
  if (!raw.startsWith('---\n')) return { raw, fields: null };
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) return { raw, fields: null };
  const fields = {};
  const lines = raw.slice(4, end).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    let value = match[2].trim();
    if (!value) {
      // Collect an indented block value so a multi-line YAML list or mapping (Gemini's `tools:`,
      // OpenCode's `permission:`) is not read as an empty declaration.
      const block = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
        block.push(lines[index + 1].trim());
        index += 1;
      }
      value = block.join(', ');
    }
    fields[match[1]] = value;
  }
  return { raw, fields };
}

function refusalBulletCount(raw) {
  const heading = /^##\s+Refus[^\n]*$/mi.exec(raw);
  if (!heading) return 0;
  const tail = raw.slice(heading.index + heading[0].length);
  const nextHeading = tail.search(/^##\s/m);
  const section = nextHeading < 0 ? tail : tail.slice(0, nextHeading);
  return (section.match(/^[-*]\s+/gm) || []).length;
}

const TURN_BUDGET_LINE = /^Complete the brief within \d+ turns\. Stop and return partial evidence instead of expanding the scope when that budget is exhausted\.$/;

function subagentBody(raw) {
  const lines = raw.split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  return lines.slice(end + 1).filter((line) => line.trim() && !TURN_BUDGET_LINE.test(line.trim())).join('\n');
}

export function subagentBodyDrift(rawByTarget) {
  const reference = rawByTarget['claude-code'];
  if (reference === undefined) return [];
  const expected = subagentBody(reference);
  return Object.entries(rawByTarget)
    .filter(([target, raw]) => target !== 'claude-code' && subagentBody(raw) !== expected)
    .map(([target]) => target);
}

function parseQuotedYamlScalar(line, key) {
  const prefix = `  ${key}: `;
  if (!line.startsWith(prefix)) return null;
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
}

function pushArrayErrors(errors, manifest, key, allowed) {
  const values = manifest[key];
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`${key} must be a non-empty array`);
    return;
  }
  if (new Set(values).size !== values.length) errors.push(`${key} contains duplicates`);
  for (const value of values) {
    if (!allowed.includes(value)) errors.push(`${key} contains unknown value '${value}'`);
  }
}

function validateAdapter(record, target, adapterRecord, taxonomy, errors) {
  const { root = ROOT, directory, manifest } = record;
  const { path: adapterPath, data: adapter } = adapterRecord;
  if (!within(directory, adapterPath) || !existsSync(adapterPath)) {
    errors.push(`adapter ${target} escapes the artifact directory or is missing`);
    return;
  }
  if (adapter.schemaVersion !== 1) errors.push(`adapter ${target} schemaVersion must be 1`);
  if (adapter.target !== target) errors.push(`adapter ${target} declares target '${adapter.target}'`);
  if (!taxonomy.targets.includes(target)) errors.push(`adapter target '${target}' is not in taxonomy`);
  if (!Array.isArray(adapter.scopes) || adapter.scopes.length === 0) errors.push(`adapter ${target} has no scopes`);
  else for (const scope of adapter.scopes) if (!taxonomy.scopes.includes(scope)) errors.push(`adapter ${target} has unknown scope '${scope}'`);
  if (!Array.isArray(adapter.files) || adapter.files.length === 0) {
    errors.push(`adapter ${target} has no files`);
    return;
  }

  if (adapter.mcpPatch !== undefined && manifest.kind !== 'mcp-server') errors.push(`adapter ${target} mcpPatch is only valid for mcp-server artifacts`);
  if (manifest.kind === 'mcp-server') {
    if (!adapter.mcpPatch || typeof adapter.mcpPatch !== 'object' || Array.isArray(adapter.mcpPatch)) {
      errors.push(`mcp-server adapter ${target} requires mcpPatch`);
    } else {
      const normalizedPath = path.posix.normalize(String(adapter.mcpPatch.path || '').replaceAll('\\', '/'));
      if (!normalizedPath || String(adapter.mcpPatch.path).includes('\\') || /^[A-Za-z]:/.test(normalizedPath)
        || path.posix.isAbsolute(normalizedPath) || normalizedPath === '..' || normalizedPath.startsWith('../')) errors.push(`mcp-server adapter ${target} has unsafe mcpPatch.path`);
      const servers = adapter.mcpPatch.servers;
      const names = servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers) : [];
      if (names.length !== 1 || names[0] !== `youdede-${manifest.slug}`) errors.push(`mcp-server adapter ${target} must patch exactly 'youdede-${manifest.slug}'`);
    }
  }

  const destinations = new Set();
  for (const mapping of adapter.files) {
    if (!mapping || typeof mapping.from !== 'string' || typeof mapping.to !== 'string') {
      errors.push(`adapter ${target} has an invalid file mapping`);
      continue;
    }
    if (mapping.root !== undefined && !['artifact', 'package'].includes(mapping.root)) {
      errors.push(`adapter ${target} source '${mapping.from}' has unknown root '${mapping.root}'`);
      continue;
    }
    const sourceRoot = mapping.root === 'package' ? root : directory;
    const source = path.resolve(sourceRoot, mapping.from);
    if (!within(sourceRoot, source) || !existsSync(source)) errors.push(`adapter ${target} source '${mapping.from}' is missing or escapes its ${mapping.root || 'artifact'} root`);
    const normalized = path.posix.normalize(mapping.to.replaceAll('\\', '/'));
    if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
      errors.push(`adapter ${target} destination '${mapping.to}' is unsafe`);
    }
    if (destinations.has(normalized)) errors.push(`adapter ${target} repeats destination '${mapping.to}'`);
    destinations.add(normalized);
  }

  if (manifest.kind === 'hook' && target === 'claude-code') {
    const hooks = adapter.settingsPatch?.hooks;
    if (!hooks || typeof hooks !== 'object' || Object.keys(hooks).length === 0) errors.push(`hook adapter ${target} requires settingsPatch.hooks`);
    for (const [event, entries] of Object.entries(hooks || {})) {
      if (!SUPPORTED_HOOK_EVENTS.has(event)) errors.push(`hook event '${event}' is not supported by this adapter contract`);
      if (!Array.isArray(entries) || entries.length === 0) errors.push(`hook event ${event} must contain entries`);
      for (const entry of entries || []) {
        if (!String(entry.description || '').includes(`[youdede:${manifest.slug}]`)) errors.push(`hook ${event} entry needs [youdede:${manifest.slug}] marker`);
        const matcher = String(entry.matcher || '');
        if (MATCHER_HOOK_EVENTS.has(event) && (!matcher || matcher === '*')) errors.push(`hook ${event} entry needs a narrow matcher`);
        if (!MATCHER_HOOK_EVENTS.has(event) && Object.hasOwn(entry, 'matcher')) errors.push(`hook ${event} does not support a matcher`);
        if (event === 'PreToolUse'
          && !/^(?:[A-Za-z0-9_]+(?:\|[A-Za-z0-9_]+)*|\^.+\$$)/.test(matcher)) {
          errors.push(`hook ${event} matcher must use exact alternatives or an anchored expression`);
        }
        if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) errors.push(`hook ${event} entry has no handlers`);
        for (const handler of entry.hooks || []) {
          if (handler?.type !== 'command') errors.push(`deterministic hook ${event} handlers must use type command`);
          if (handler?.async === true) errors.push(`enforcement hook ${event} handlers may not be asynchronous`);
          if (!String(handler?.command || '').includes('{claudeRoot}/hooks/youdede/')) {
            errors.push(`hook ${event} command must resolve its installed toolkit path`);
          }
          if (!Number.isInteger(handler?.timeout) || handler.timeout < 1 || handler.timeout > 30) {
            errors.push(`hook ${event} timeout must be an integer from 1 through 30 seconds`);
          }
        }
      }
    }
  }

  if (manifest.kind === 'hook' && target === 'codex') {
    if (adapter.settingsPatch?.path !== 'hooks.json') errors.push('Codex hooks must patch hooks.json');
    const hooks = adapter.settingsPatch?.hooks;
    if (!hooks || Object.keys(hooks).some((event) => event !== 'PreToolUse')) errors.push('Codex guard adapters may only declare the validated PreToolUse boundary');
    for (const entry of Object.values(hooks || {}).flat()) {
      if (entry?.matcher !== 'Bash') errors.push('Codex shell guard adapters must use the native Bash matcher');
      if (!Array.isArray(entry?.hooks) || entry.hooks.length !== 1) errors.push('Codex shell guard entries require exactly one command handler');
      for (const handler of entry?.hooks || []) {
        if (handler?.type !== 'command') errors.push('Codex deterministic hooks require command handlers');
        if (handler?.async === true) errors.push('Codex enforcing hooks may not run asynchronously');
        if (!String(handler?.statusMessage || '').includes(`[youdede:${manifest.slug}]`)) errors.push('Codex hook handler needs its stable marker');
        if (!String(handler?.command || '').includes('{codexRoot}/hooks/youdede/')) errors.push('Codex hook command must resolve its installed path');
        if (!Number.isInteger(handler?.timeout) || handler.timeout < 1 || handler.timeout > 30) errors.push('Codex hook timeout must be 1-30 seconds');
      }
    }
  }

  if (manifest.kind === 'hook' && target === 'gemini-cli') {
    if (adapter.settingsPatch?.path && adapter.settingsPatch.path !== 'settings.json') errors.push('Gemini CLI hooks must patch settings.json');
    const hooks = adapter.settingsPatch?.hooks;
    if (!hooks || Object.keys(hooks).some((event) => event !== 'BeforeTool')) errors.push('Gemini CLI guard adapters may only declare the validated BeforeTool boundary');
    for (const entry of Object.values(hooks || {}).flat()) {
      if (!entry?.matcher || entry.matcher === '*') errors.push('Gemini CLI BeforeTool entries need a narrow matcher');
      if (Object.hasOwn(entry || {}, 'description')) errors.push('Gemini CLI hook identity belongs on the command handler');
      for (const handler of entry?.hooks || []) {
        if (handler?.type !== 'command') errors.push('Gemini CLI deterministic hooks require command handlers');
        if (!String(handler?.name || '').startsWith('youdede-')) errors.push('Gemini CLI hook handler needs a youdede name');
        if (!String(handler?.description || '').includes(`[youdede:${manifest.slug}]`)) errors.push('Gemini CLI hook handler needs its stable marker');
        if (!String(handler?.command || '').includes('{geminiRoot}/hooks/youdede/')) errors.push('Gemini CLI hook command must resolve its installed path');
        if (!Number.isInteger(handler?.timeout) || handler.timeout < 1000 || handler.timeout > 30000) errors.push('Gemini CLI hook timeout must be 1000-30000 milliseconds');
      }
    }
  }

  if (manifest.kind === 'hook' && target === 'cursor') {
    if (adapter.settingsPatch?.path !== 'hooks.json') errors.push('Cursor hooks must patch hooks.json');
    const hooks = adapter.settingsPatch?.hooks;
    if (!hooks || Object.keys(hooks).some((event) => event !== 'preToolUse')) errors.push('Cursor guard adapters may only declare the validated preToolUse boundary');
    for (const entry of Object.values(hooks || {}).flat()) {
      if (entry?.type !== 'command' || !entry.matcher || entry.matcher === '*') errors.push('Cursor preToolUse hooks require a narrow command matcher');
      if (entry?.failClosed !== true) errors.push('Cursor enforcing hooks must set failClosed');
      if (!String(entry?.command || '').includes(`[youdede:${manifest.slug}]`)) errors.push('Cursor hook command needs its stable marker');
      if (!Number.isInteger(entry?.timeout) || entry.timeout < 1 || entry.timeout > 30) errors.push('Cursor hook timeout must be 1-30 seconds');
    }
  }

  if (manifest.kind === 'hook' && ['github-copilot', 'opencode'].includes(target) && adapter.settingsPatch) {
    errors.push(`${target} hook adapters must own native config/plugin files instead of merging settings`);
  }
  if (manifest.kind === 'hook' && target !== 'claude-code') {
    if (!Array.isArray(adapter.bindings) || adapter.bindings.length === 0) errors.push(`${target} hook adapter must declare native bindings`);
    for (const binding of adapter.bindings || []) {
      if (typeof binding?.event !== 'string' || typeof binding?.matcher !== 'string' || !binding.matcher) errors.push(`${target} hook binding is invalid`);
    }
  }
}

function validateSlugList(errors, values, prefix, { minItems = 0, minLength = 1, maxLength = 200 } = {}) {
  if (!Array.isArray(values) || values.length < minItems) {
    errors.push(`${prefix} must be an array with at least ${minItems} entries`);
    return;
  }
  if (new Set(values).size !== values.length) errors.push(`${prefix} contains duplicates`);
  for (const value of values) {
    if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
      errors.push(`${prefix} entries must be strings of ${minLength}-${maxLength} characters`);
    }
  }
}

function isIsoCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateKindContract(manifest, errors) {
  const execution = manifest.execution;
  if (manifest.kind === 'command') {
    const contract = manifest.command;
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
      errors.push('command artifacts require a command contract object');
      return;
    }
    if (contract.invocation !== manifest.slug) errors.push('command.invocation must match the slug');
    validateSlugList(errors, contract.toolAuthority, 'command.toolAuthority');
    for (const tool of contract.toolAuthority || []) {
      if (typeof tool === 'string' && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(tool)) errors.push(`command.toolAuthority entry '${tool}' is not a valid tool name`);
    }
    validateSlugList(errors, contract.produces, 'command.produces', { minItems: 1, minLength: 10 });
    validateSlugList(errors, contract.requires, 'command.requires', { minLength: 10 });
    if (!Array.isArray(contract.flags)) errors.push('command.flags must be an array');
    else {
      const flagNames = new Set();
      for (const [index, flag] of contract.flags.entries()) {
        const prefix = `command.flags[${index}]`;
        if (!flag || typeof flag !== 'object') { errors.push(`${prefix} must be an object`); continue; }
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(flag.name || '')) errors.push(`${prefix}.name must use lowercase hyphen-case`);
        else if (flagNames.has(flag.name)) errors.push(`${prefix}.name duplicates flag '${flag.name}'`);
        else flagNames.add(flag.name);
        if (flag.effect !== 'narrow') errors.push(`${prefix}.effect must be 'narrow': flags may only restrict authority`);
        if (typeof flag.description !== 'string' || flag.description.length < 15) errors.push(`${prefix}.description must contain at least 15 characters`);
      }
    }
    if (execution?.mode === 'deterministic') errors.push('commands direct an agent and may not declare deterministic execution');
  }
  if (manifest.kind === 'context') {
    const contract = manifest.context;
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
      errors.push('context artifacts require a context contract object');
      return;
    }
    if (!['always', 'glob'].includes(contract.scope)) errors.push('context.scope must be always or glob');
    if (contract.scope === 'glob' && (!Array.isArray(contract.globs) || contract.globs.length === 0)) errors.push('glob-scoped contexts require a non-empty globs list');
    if (contract.scope === 'always' && Array.isArray(contract.globs) && contract.globs.length > 0) errors.push('always-scoped contexts may not declare globs');
    for (const glob of contract.globs || []) {
      if (typeof glob === 'string' && (glob.startsWith('/') || glob.split('/').includes('..') || glob.includes('\\') || /^[A-Za-z]:/.test(glob))) errors.push(`context.globs entry '${glob}' is not a safe portable relative glob`);
    }
    if (Array.isArray(contract.globs) && new Set(contract.globs).size !== contract.globs.length) errors.push('context.globs contains duplicates');
    if (!Number.isInteger(contract.precedence) || contract.precedence < 0 || contract.precedence > 1000) errors.push('context.precedence must be an integer between 0 and 1000');
    if (contract.expires !== undefined && !isIsoCalendarDate(contract.expires)) errors.push('context.expires must be a real ISO calendar date');
    if (!Array.isArray(contract.provenance) || contract.provenance.length === 0) errors.push('context.provenance must list the catalog artifacts its rules descend from');
    else if (new Set(contract.provenance).size !== contract.provenance.length) errors.push('context.provenance contains duplicates');
    if (!Array.isArray(contract.rules) || contract.rules.length === 0) errors.push('context.rules must contain at least one provenance-linked rule');
    else {
      const ruleIds = new Set();
      for (const [index, rule] of contract.rules.entries()) {
        const prefix = `context.rules[${index}]`;
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) { errors.push(`${prefix} must be an object`); continue; }
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.id || '')) errors.push(`${prefix}.id must use lowercase hyphen-case`);
        else if (ruleIds.has(rule.id)) errors.push(`${prefix}.id duplicates rule '${rule.id}'`);
        else ruleIds.add(rule.id);
        if (!['require', 'forbid'].includes(rule.effect)) errors.push(`${prefix}.effect must be require or forbid`);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.action || '')) errors.push(`${prefix}.action must use lowercase hyphen-case`);
        if (!(contract.provenance || []).includes(rule.sourceArtifactId)) errors.push(`${prefix}.sourceArtifactId must appear in context.provenance`);
        if (!['summary', 'refuses'].includes(rule.sourceField)) errors.push(`${prefix}.sourceField must be summary or refuses`);
        if (rule.sourceField === 'summary' && rule.sourceIndex !== undefined) errors.push(`${prefix}.sourceIndex is only valid for refuses`);
        if (rule.sourceField === 'summary' && rule.effect !== 'require') errors.push(`${prefix} sourced from summary must require its action`);
        if (rule.sourceField === 'refuses' && (!Number.isInteger(rule.sourceIndex) || rule.sourceIndex < 0)) errors.push(`${prefix}.sourceIndex must select a refusal`);
        if (rule.sourceField === 'refuses' && rule.effect !== 'forbid') errors.push(`${prefix} sourced from refuses must forbid its action`);
        // A refusal says what its source does not do; read as a rule it forbids the wrong thing.
        if (rule.sourceField === 'refuses' && !/^Do not \S/.test(rule.text ?? '')) errors.push(`${prefix} sourced from refuses must state its prohibition in text starting with "Do not"`);
        if (rule.text !== undefined && rule.sourceField !== 'refuses') errors.push(`${prefix}.text is only valid for rules sourced from refuses`);
      }
    }
    if (execution && (execution.mode !== 'prompt' || execution.entrypoints.length !== 0)) errors.push('contexts are pure content and must declare prompt execution without entrypoints');
  }
  if (manifest.hookGuard !== undefined) {
    if (manifest.kind !== 'hook') errors.push('hookGuard is only valid on hook artifacts');
    if (!Array.isArray(manifest.hookGuard?.blockedActions) || manifest.hookGuard.blockedActions.length === 0) errors.push('hookGuard.blockedActions must contain at least one action');
    else {
      if (new Set(manifest.hookGuard.blockedActions).size !== manifest.hookGuard.blockedActions.length) errors.push('hookGuard.blockedActions contains duplicates');
      for (const action of manifest.hookGuard.blockedActions) {
        if (typeof action !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(action)) errors.push(`hookGuard.blockedActions entry '${action}' must use lowercase hyphen-case`);
      }
    }
  }
  if (manifest.kind === 'mcp-server') {
    const contract = manifest.mcpServer;
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
      errors.push('mcp-server artifacts require an mcpServer contract object');
      return;
    }
    if (!['stdio', 'sse', 'http'].includes(contract.transport)) errors.push('mcpServer.transport must be stdio, sse, or http');
    validateSlugList(errors, contract.egress, 'mcpServer.egress', { minItems: 1 });
    if ((contract.egress || []).includes('none') && contract.egress.length !== 1) errors.push("mcpServer.egress 'none' may not be combined with destinations");
    validateSlugList(errors, contract.secretAccess, 'mcpServer.secretAccess', { minItems: 1 });
    if ((contract.secretAccess || []).includes('none') && contract.secretAccess.length !== 1) errors.push("mcpServer.secretAccess 'none' may not be combined with variable names");
    for (const name of contract.secretAccess || []) {
      if (typeof name === 'string' && name !== 'none' && !/^[A-Z][A-Z0-9_]*$/.test(name)) errors.push(`mcpServer.secretAccess entry '${name}' must be an ENV-style variable name`);
    }
    if (typeof contract.trustBoundary !== 'string' || contract.trustBoundary.length < 40 || contract.trustBoundary.length > 400) errors.push('mcpServer.trustBoundary must contain 40-400 characters');
    if (!Array.isArray(contract.pinnedTools)) errors.push('mcpServer.pinnedTools must be an array');
    else for (const [index, tool] of contract.pinnedTools.entries()) {
      const prefix = `mcpServer.pinnedTools[${index}]`;
      if (!tool || typeof tool !== 'object') { errors.push(`${prefix} must be an object`); continue; }
      if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(tool.name || '')) errors.push(`${prefix}.name must use lowercase tool-name format`);
      if (!/^[0-9a-f]{64}$/.test(tool.descriptionHash || '')) errors.push(`${prefix}.descriptionHash must be a lowercase sha256 hex digest`);
    }
    if (execution && execution.mode === 'deterministic') errors.push('mcp-server artifacts declare configuration and may not declare deterministic execution');
    if (manifest.risk === 'low' && (contract.egress || []).some((d) => d !== 'none')) errors.push('an mcp-server with network egress may not declare low risk');
  }
}

export function validateArtifact(record, taxonomy, artifactsRoot = ARTIFACTS_ROOT) {
  const { directory, manifest, adapters } = record;
  const errors = [];
  const requiredStrings = ['id', 'slug', 'name', 'version', 'kind', 'summary', 'description', 'domain', 'category', 'risk', 'license'];
  for (const key of requiredStrings) if (typeof manifest[key] !== 'string' || !manifest[key].trim()) errors.push(`${key} must be a non-empty string`);
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version || '')) errors.push('version must be semver');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.slug || '')) errors.push('slug must use lowercase hyphen-case');
  if (String(manifest.slug || '').length > 64) errors.push('slug must be at most 64 characters');
  if (String(manifest.name || '').length < 3 || String(manifest.name || '').length > 80) errors.push('name must contain 3-80 characters');
  if (String(manifest.summary || '').length < 20 || String(manifest.summary || '').length > 140) errors.push('summary must contain 20-140 characters');
  if (String(manifest.description || '').length < 40 || String(manifest.description || '').length > 600) errors.push('description must contain 40-600 characters');
  if (!taxonomy.kinds.includes(manifest.kind)) errors.push(`unknown kind '${manifest.kind}'`);
  if (!Object.hasOwn(taxonomy.domains, manifest.domain)) errors.push(`unknown domain '${manifest.domain}'`);
  else if (!taxonomy.domains[manifest.domain].includes(manifest.category)) errors.push(`category '${manifest.category}' does not belong to '${manifest.domain}'`);
  if (!taxonomy.risk.includes(manifest.risk)) errors.push(`unknown risk '${manifest.risk}'`);
  if (typeof manifest.risk_reason !== 'string' || manifest.risk_reason.trim().length < 25 || manifest.risk_reason.length > 400) {
    errors.push('risk_reason must be a concrete 25-400 character explanation');
  }
  if (manifest.license !== 'MIT') errors.push('artifact license must be MIT');
  pushArrayErrors(errors, manifest, 'problems', taxonomy.problems);
  pushArrayErrors(errors, manifest, 'capabilities', taxonomy.capabilities);
  pushArrayErrors(errors, manifest, 'frameworks', taxonomy.frameworks);
  pushArrayErrors(errors, manifest, 'languages', taxonomy.languages);
  pushArrayErrors(errors, manifest, 'lifecycle', taxonomy.lifecycle);
  if (!Array.isArray(manifest.authors) || manifest.authors.length === 0) errors.push('authors must be non-empty');
  else for (const author of manifest.authors) if (typeof author !== 'string' || author.length < 2) errors.push('authors must contain names of at least two characters');
  if (!Array.isArray(manifest.refuses) || manifest.refuses.length < 3) errors.push('refuses must contain at least three boundaries');
  else for (const refusal of manifest.refuses) if (typeof refusal !== 'string' || refusal.length < 15) errors.push('refuses entries must contain at least 15 characters');

  const plural = KIND_PLURALS[manifest.kind];
  if (!plural) errors.push(`no directory mapping for kind '${manifest.kind}'`);
  const expectedRelative = [plural, manifest.domain, manifest.category, manifest.slug].join(path.sep);
  const actualRelative = path.relative(artifactsRoot, directory);
  if (actualRelative !== expectedRelative) errors.push(`directory must match ${expectedRelative}`);
  const expectedId = `${manifest.kind}/${manifest.domain}/${manifest.category}/${manifest.slug}`;
  if (manifest.id !== expectedId) errors.push(`id must be '${expectedId}'`);

  const execution = manifest.execution;
  if (!execution || !['prompt', 'hybrid', 'deterministic'].includes(execution.mode) || !Array.isArray(execution.entrypoints)) {
    errors.push('execution requires a valid mode and entrypoints array');
  } else {
    if (execution.mode === 'prompt' && execution.entrypoints.length !== 0) errors.push('prompt execution may not declare deterministic entrypoints');
    if (execution.mode !== 'prompt' && execution.entrypoints.length === 0) errors.push(`${execution.mode} execution requires at least one entrypoint`);
    if (manifest.kind === 'hook' && execution.mode !== 'deterministic') errors.push('hooks must declare deterministic execution');
    const entrypointPaths = new Set();
    for (const [index, entrypoint] of execution.entrypoints.entries()) {
      const prefix = `execution.entrypoints[${index}]`;
      if (!entrypoint || typeof entrypoint.path !== 'string') {
        errors.push(`${prefix}.path is required`);
        continue;
      }
      const absolute = path.resolve(directory, entrypoint.path);
      if (!within(directory, absolute) || !existsSync(absolute) || !statSync(absolute).isFile()) errors.push(`${prefix}.path is missing or unsafe`);
      if (entrypointPaths.has(entrypoint.path)) errors.push(`${prefix}.path is duplicated`);
      entrypointPaths.add(entrypoint.path);
      if (!['node', 'python', 'shell', 'runtime'].includes(entrypoint.runtime)) errors.push(`${prefix}.runtime is invalid`);
      if (!['none', 'read-only', 'writes-files', 'external'].includes(entrypoint.sideEffects)) errors.push(`${prefix}.sideEffects is invalid`);
      if (typeof entrypoint.purpose !== 'string' || entrypoint.purpose.length < 20 || entrypoint.purpose.length > 200) errors.push(`${prefix}.purpose must contain 20-200 characters`);
    }
    for (const [target, adapter] of Object.entries(adapters)) {
      for (const entrypoint of execution.entrypoints) {
        const absolute = path.resolve(directory, entrypoint.path);
        const packaged = (adapter.data.files || []).some((mapping) => {
          if (mapping.root === 'package') return false;
          const source = path.resolve(directory, mapping.from);
          if (!existsSync(source)) return false;
          return statSync(source).isDirectory() ? within(source, absolute) : source === absolute;
        });
        if (!packaged) errors.push(`execution entrypoint '${entrypoint.path}' is not packaged by adapter ${target}`);
      }
    }
  }

  const relationships = manifest.relationships;
  const relationshipKeys = ['composesWith', 'conflictsWith', 'supersedes', 'prerequisites', 'packIds'];
  if (!relationships || typeof relationships !== 'object' || Array.isArray(relationships)) {
    errors.push('relationships must be an object');
  } else {
    for (const key of relationshipKeys) {
      if (!Array.isArray(relationships[key])) errors.push(`relationships.${key} must be an array`);
      else {
        if (new Set(relationships[key]).size !== relationships[key].length) errors.push(`relationships.${key} contains duplicates`);
        if (relationships[key].some((value, index) => index > 0 && relationships[key][index - 1].localeCompare(value) > 0)) {
          errors.push(`relationships.${key} must be sorted`);
        }
      }
    }
  }

  validateKindContract(manifest, errors);

  const operational = manifest.operational;
  if (!operational || typeof operational !== 'object' || Array.isArray(operational)) {
    errors.push('operational must be an object');
  } else {
    if (!['advisory', 'enforcing', 'observing'].includes(operational.behavior)) errors.push('operational.behavior is invalid');
    if (!['stop-and-report', 'fail-closed', 'fail-open'].includes(operational.failurePolicy)) errors.push('operational.failurePolicy is invalid');
    if (!['immediate', 'bounded', 'background'].includes(operational.latencyClass)) errors.push('operational.latencyClass is invalid');
    if (typeof operational.latency_reason !== 'string' || operational.latency_reason.trim().length < 25 || operational.latency_reason.length > 400) {
      errors.push('operational.latency_reason must be a concrete 25-400 character explanation');
    }
    if (!['none', 'runtime-managed', 'local-bounded'].includes(operational.dataRetention)) errors.push('operational.dataRetention is invalid');
    if (manifest.kind === 'hook' && operational.behavior === 'advisory') errors.push('hooks may not declare advisory behavior');
    if (operational.behavior === 'enforcing' && operational.failurePolicy === 'stop-and-report') errors.push('enforcing artifacts require fail-open or fail-closed policy');
    if (operational.behavior === 'observing' && operational.failurePolicy !== 'fail-open') errors.push('observing artifacts must fail open');
  }

  if (!manifest.adapters || typeof manifest.adapters !== 'object' || Object.keys(manifest.adapters).length === 0) errors.push('adapters must be non-empty');
  for (const [target, adapter] of Object.entries(adapters)) validateAdapter(record, target, adapter, taxonomy, errors);

  if (manifest.kind === 'skill') {
    if (!SKILL_VERBS.has(String(manifest.slug).split('-')[0])) errors.push('skill slug must start with an approved action verb');
    const skillFile = path.join(directory, 'SKILL.md');
    if (!existsSync(skillFile)) errors.push('skill requires SKILL.md');
    else {
      const { fields, raw } = parseFrontmatter(skillFile);
      if (!fields) errors.push('SKILL.md requires YAML frontmatter');
      else {
        if (fields.name !== manifest.slug) errors.push('SKILL.md name must match slug');
        if (!fields.description || fields.description.length < 40) errors.push('SKILL.md description is too weak');
        if (!/\bUse (?:when|for|before|after)\b/i.test(fields.description || '')) errors.push('SKILL.md description needs an explicit Use when/for/before/after trigger');
        const extra = Object.keys(fields).filter((key) => !['name', 'description'].includes(key));
        if (extra.length) errors.push(`SKILL.md has unsupported frontmatter: ${extra.join(', ')}`);
      }
      if (!raw.includes('## Refusals')) errors.push('SKILL.md must document Refusals');
      if (refusalBulletCount(raw) < 3) errors.push('SKILL.md must document at least three concrete refusals');
      if (raw.split(/\r?\n/).length >= 500) errors.push('SKILL.md must stay below 500 lines');
      if (/\bTODO\b|\[TODO/.test(raw)) errors.push('SKILL.md contains TODO placeholders');
    }
    const interfaceFile = path.join(directory, 'agents', 'openai.yaml');
    if (!existsSync(interfaceFile)) errors.push('skill requires agents/openai.yaml for future Codex packaging');
    else {
      const lines = readFileSync(interfaceFile, 'utf8').split('\n');
      if (lines[0] !== 'interface:') errors.push('agents/openai.yaml requires an interface mapping');
      const displayName = parseQuotedYamlScalar(lines.find((line) => line.trimStart().startsWith('display_name:')) || '', 'display_name');
      const shortDescription = parseQuotedYamlScalar(lines.find((line) => line.trimStart().startsWith('short_description:')) || '', 'short_description');
      const defaultPrompt = parseQuotedYamlScalar(lines.find((line) => line.trimStart().startsWith('default_prompt:')) || '', 'default_prompt');
      if (typeof displayName !== 'string' || displayName.length < 3 || displayName.length > 64) errors.push('agents/openai.yaml display_name must contain 3-64 characters');
      if (typeof shortDescription !== 'string' || shortDescription.length < 25 || shortDescription.length > 64) errors.push('agents/openai.yaml short_description must contain 25-64 characters');
      if (typeof defaultPrompt !== 'string' || !defaultPrompt.includes(`$${manifest.slug}`)) errors.push('agents/openai.yaml default_prompt must mention the skill slug');
    }
    const codex = adapters.codex?.data;
    if (codex) {
      const requiredPayloads = ['SKILL.md', 'agents/openai.yaml'];
      for (const required of requiredPayloads) {
        const absolute = path.resolve(directory, required);
        const packaged = codex.files.some((mapping) => {
          const source = path.resolve(directory, mapping.from);
          if (!existsSync(source)) return false;
          return statSync(source).isDirectory() ? within(source, absolute) : source === absolute;
        });
        if (!packaged) errors.push(`Codex adapter must package '${required}'`);
      }
      for (const mapping of codex.files) {
        const destination = path.posix.normalize(mapping.to.replaceAll('\\', '/'));
        if (destination !== `skills/{slug}` && !destination.startsWith('skills/{slug}/')) {
          errors.push(`Codex skill destination '${mapping.to}' must stay under skills/{slug}`);
        }
      }
    }
  }

  if (manifest.kind === 'command') {
    const commandFile = path.join(directory, 'COMMAND.md');
    if (!existsSync(commandFile)) {
      errors.push('command requires COMMAND.md');
    } else {
      const { fields, raw } = parseFrontmatter(commandFile);
      if (!fields) {
        errors.push('COMMAND.md requires YAML frontmatter');
      } else {
        if (!fields.description || fields.description.length < 40) errors.push('COMMAND.md description is too weak');
        if (!/\bUse (?:when|for|before|after)\b/i.test(fields.description || '')) errors.push('COMMAND.md description needs an explicit Use when/for/before/after trigger');
        const declaredTools = new Set(manifest.command?.toolAuthority || []);
        const frontmatterTools = new Set(String(fields['allowed-tools'] || '').split(',').map((tool) => tool.trim()).filter(Boolean));
        if (declaredTools.size !== frontmatterTools.size || [...declaredTools].some((tool) => !frontmatterTools.has(tool))) {
          errors.push('COMMAND.md allowed-tools must match command.toolAuthority exactly');
        }
      }
      if (!raw.includes('## Refusals') || refusalBulletCount(raw) < 3) errors.push('COMMAND.md must document at least three refusals');
    }
    for (const [target, adapter] of Object.entries(adapters)) {
      for (const mapping of adapter.data.files || []) {
        if (mapping.root === 'package') continue;
        if (!String(mapping.to).startsWith('commands/')) errors.push(`adapter ${target} destination '${mapping.to}' must stay under commands/`);
      }
    }
    const preconditionsFile = path.join(directory, 'preconditions.json');
    if (!existsSync(preconditionsFile)) errors.push('command requires a declared preconditions.json');
  }

  if (manifest.kind === 'subagent') {
    if (!SUBAGENT_ROLES.has(String(manifest.slug).split('-').at(-1))) errors.push('subagent slug must end with an approved role');
    // Every target ships its own payload with its own frontmatter dialect, and each one is
    // installed on its own. Validating only the first adapter left the rest free to lose their
    // refusals, tool allowlist, or name match while the catalog still reported the artifact valid.
    const entries = Object.entries(adapters)
      .map(([target, adapter]) => [target, adapter.data.files?.[0]])
      .filter(([, mapping]) => mapping);
    if (!entries.length) errors.push('subagent payload is missing');
    const bodies = {};
    for (const [target, mapping] of entries) {
      const agentFile = path.resolve(directory, mapping.from);
      if (!existsSync(agentFile)) {
        errors.push(`${target}: subagent payload is missing`);
        continue;
      }
      const { fields, raw } = parseFrontmatter(agentFile);
      if (!fields) {
        errors.push(`${target}: subagent payload needs frontmatter`);
        continue;
      }
      bodies[target] = raw;
      if (!fields.description) errors.push(`${target}: subagent frontmatter needs a description`);
      if (target === 'opencode') {
        // OpenCode takes the agent name from the filename, so identity is checked there and
        // bounded authority is expressed as a permission mapping rather than a tools list.
        if (path.basename(mapping.from) !== `${manifest.slug}.md`) errors.push(`${target}: subagent payload filename must be ${manifest.slug}.md`);
        if (!fields.permission) errors.push(`${target}: subagent must declare a bounded permission mapping`);
      } else {
        if (fields.name !== manifest.slug) errors.push(`${target}: subagent frontmatter name must match the slug`);
        if (!fields.tools) errors.push(`${target}: subagent must declare a bounded tools list`);
      }
      if (!raw.includes('## Refusals')) errors.push(`${target}: subagent must document Refusals`);
      if (refusalBulletCount(raw) < 3) errors.push(`${target}: subagent must document at least three concrete refusals`);
    }
    for (const target of subagentBodyDrift(bodies)) errors.push(`${target}: subagent body differs from the claude-code payload`);
  }

  if (manifest.kind === 'hook') {
    if (!String(manifest.slug).endsWith('-guard')) errors.push('hook slug must end with -guard');
    for (const adapter of Object.values(adapters)) {
      for (const mapping of adapter.data.files) {
        const sourceRoot = mapping.root === 'package' ? (record.root || ROOT) : directory;
        const source = path.resolve(sourceRoot, mapping.from);
        if (existsSync(source) && statSync(source).isFile()) {
          const raw = readFileSync(source, 'utf8');
          if ((mapping.executable || /\.(?:m?js|cjs|sh|py)$/.test(mapping.from)) && !raw.startsWith('#!')) errors.push(`${mapping.from} needs an executable shebang`);
          if (process.platform !== 'win32' && mapping.executable && (statSync(source).mode & 0o111) === 0) errors.push(`${mapping.from} is marked executable but has no execute bit`);
          if (/\beval\s*\(/.test(raw)) errors.push(`${mapping.from} may not use eval`);
        }
      }
    }
    const readme = [...Object.values(adapters).flatMap((adapter) => adapter.data.files
      .filter((mapping) => mapping.root !== 'package')
      .map((mapping) => path.dirname(path.resolve(directory, mapping.from))))]
      .map((folder) => path.join(folder, 'README.md'))
      .find(existsSync);
    if (!readme || refusalBulletCount(readFileSync(readme, 'utf8')) < 3) errors.push('hook target README must document at least three refusals');
  }

  return errors;
}

function canonicalCycle(cycle) {
  const body = cycle.slice(0, -1);
  const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)]);
  rotations.sort((left, right) => left.join('\0').localeCompare(right.join('\0')));
  return [...rotations[0], rotations[0][0]];
}

function relationshipCycles(manifests, key) {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const state = new Map();
  const stack = [];
  const found = new Map();

  function visit(id) {
    state.set(id, 'active');
    stack.push(id);
    const related = [...(byId.get(id)?.relationships?.[key] || [])].filter((candidate) => byId.has(candidate)).sort();
    for (const relatedId of related) {
      if (!state.has(relatedId)) visit(relatedId);
      else if (state.get(relatedId) === 'active') {
        const start = stack.lastIndexOf(relatedId);
        const cycle = canonicalCycle([...stack.slice(start), relatedId]);
        found.set(cycle.slice(0, -1).join('\0'), cycle);
      }
    }
    stack.pop();
    state.set(id, 'done');
  }

  for (const id of [...byId.keys()].sort()) if (!state.has(id)) visit(id);
  return [...found.values()].sort((left, right) => left.join('\0').localeCompare(right.join('\0')));
}

export function validateRelationshipIntegrity(results, packs) {
  const resultById = new Map(results.map((result) => [result.record.manifest.id, result]));
  const knownIds = new Set(resultById.keys());
  const packById = new Map(packs.map((record) => [record.manifest.id, record.manifest]));
  const packIds = new Set(packById.keys());

  for (const result of results) {
    const manifest = result.record.manifest;
    const relationships = manifest.relationships || {};
    for (const key of ARTIFACT_RELATIONSHIP_KEYS) {
      for (const artifactId of relationships[key] || []) {
        if (artifactId === manifest.id) result.errors.push(`relationships.${key} may not reference the artifact itself`);
        else if (!knownIds.has(artifactId)) result.errors.push(`relationships.${key} references unknown artifact '${artifactId}'`);
      }
    }
    for (const packId of relationships.packIds || []) {
      if (!packIds.has(packId)) result.errors.push(`relationships.packIds references unknown pack '${packId}'`);
    }
    for (const sourceId of manifest.context?.provenance || []) {
      if (sourceId === manifest.id) result.errors.push('context.provenance may not reference the context itself');
      else if (!knownIds.has(sourceId)) result.errors.push(`context.provenance references unknown artifact '${sourceId}'`);
    }
    for (const [index, rule] of (manifest.context?.rules || []).entries()) {
      const source = resultById.get(rule.sourceArtifactId)?.record.manifest;
      if (!source) continue;
      if (rule.sourceField === 'summary' && typeof source.summary !== 'string') {
        result.errors.push(`context.rules[${index}] references a missing summary on '${rule.sourceArtifactId}'`);
      }
      if (rule.sourceField === 'refuses' && typeof source.refuses?.[rule.sourceIndex] !== 'string') {
        result.errors.push(`context.rules[${index}] references missing refusal ${rule.sourceIndex} on '${rule.sourceArtifactId}'`);
      }
    }
  }

  for (const { manifest: pack } of packs) {
    for (const { artifactId } of pack.members || []) {
      const artifactResult = resultById.get(artifactId);
      if (artifactResult && !(artifactResult.record.manifest.relationships?.packIds || []).includes(pack.id)) {
        artifactResult.errors.push(`relationships.packIds must include containing pack '${pack.id}'`);
      }
    }
  }

  for (const result of results) {
    const manifest = result.record.manifest;
    for (const packId of manifest.relationships?.packIds || []) {
      const pack = packById.get(packId);
      if (pack && !pack.members.some(({ artifactId }) => artifactId === manifest.id)) {
        result.errors.push(`relationships.packIds names '${packId}' but the pack does not contain this artifact`);
      }
    }
    for (const key of ['composesWith', 'conflictsWith']) {
      for (const relatedId of manifest.relationships?.[key] || []) {
        const reverse = resultById.get(relatedId)?.record.manifest.relationships?.[key] || [];
        if (!reverse.includes(manifest.id)) result.errors.push(`relationships.${key} with '${relatedId}' is not symmetric`);
      }
    }
  }

  const manifests = results.map((result) => result.record.manifest);
  for (const pair of uniquePairs(manifests, 'conflictsWith')) {
    const [leftId, rightId] = pair.split('\0');
    const left = resultById.get(leftId)?.record.manifest;
    const right = resultById.get(rightId)?.record.manifest;
    if (!left || !right) continue;
    if (left.relationships.composesWith.includes(rightId) || right.relationships.composesWith.includes(leftId)) {
      resultById.get(leftId).errors.push(`relationships with '${rightId}' may not both compose and conflict`);
    }
    if (left.relationships.prerequisites.includes(rightId) || right.relationships.prerequisites.includes(leftId)) {
      resultById.get(leftId).errors.push(`relationships with '${rightId}' may not both require and conflict`);
    }
  }
  for (const key of ['prerequisites', 'supersedes']) {
    for (const cycle of relationshipCycles(manifests, key)) {
      resultById.get(cycle[0])?.errors.push(`relationships.${key} contains cycle '${cycle.join(' -> ')}'`);
    }
  }
}

export function findContextHookConflicts(records) {
  const contexts = records.filter(({ manifest }) => manifest.kind === 'context');
  const hooks = records.filter(({ manifest }) => manifest.kind === 'hook' && manifest.hookGuard?.blockedActions?.length);
  const conflicts = [];
  for (const context of contexts) {
    for (const rule of context.manifest.context?.rules || []) {
      if (rule.effect !== 'require') continue;
      for (const hook of hooks) {
        if (!hook.manifest.hookGuard.blockedActions.includes(rule.action)) continue;
        conflicts.push({
          contextId: context.manifest.id,
          ruleId: rule.id,
          action: rule.action,
          hookId: hook.manifest.id
        });
      }
    }
  }
  return conflicts.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function orderContextRecords(records) {
  return records
    .filter(({ manifest }) => manifest.kind === 'context')
    .sort((left, right) => left.manifest.context.precedence - right.manifest.context.precedence
      || left.manifest.id.localeCompare(right.manifest.id));
}

export function validateRepository(root = ROOT) {
  const taxonomy = loadTaxonomy(root);
  const artifacts = loadArtifacts(root);
  const artifactsRoot = path.join(root, 'artifacts');
  const results = artifacts.map((record) => ({ record, errors: validateArtifact(record, taxonomy, artifactsRoot) }));
  const ids = new Map();
  const slugs = new Map();
  for (const result of results) {
    const { id, slug } = result.record.manifest;
    if (ids.has(id)) result.errors.push(`duplicate id also used by ${ids.get(id)}`);
    else ids.set(id, result.record.manifestPath);
    if (slugs.has(slug)) result.errors.push(`duplicate slug also used by ${slugs.get(slug)}`);
    else slugs.set(slug, result.record.manifestPath);
  }
  const knownIds = new Set(artifacts.map(({ manifest }) => manifest.id));
  const packs = loadPacks(root);
  validateRelationshipIntegrity(results, packs);
  const packResults = packs.map((record) => ({ record, errors: validatePack(record, knownIds, artifacts, root) }));
  const seenPacks = new Set();
  for (const result of packResults) {
    const id = result.record.manifest.id;
    if (seenPacks.has(id)) result.errors.push(`duplicate pack id '${id}'`);
    seenPacks.add(id);
  }
  return { taxonomy, artifacts, results, packs, packResults };
}

export function validatePack(record, knownIds, artifacts, root = ROOT) {
  const { manifest, directory } = record;
  const errors = [];
  const allowedPackKeys = ['$schema', 'schemaVersion', 'id', 'slug', 'name', 'version', 'summary', 'outcomes', 'evidence', 'members'];
  const packKeys = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? Object.keys(manifest) : [];
  for (const key of allowedPackKeys) if (!packKeys.includes(key)) errors.push(`pack is missing required property '${key}'`);
  for (const key of packKeys) if (!allowedPackKeys.includes(key)) errors.push(`pack has unexpected property '${key}'`);
  if (typeof manifest.$schema !== 'string' || path.resolve(directory, manifest.$schema || '') !== path.join(root, 'schema', 'pack.schema.json')) {
    errors.push('$schema must resolve to schema/pack.schema.json');
  }
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version || '')) errors.push('version must be semver');
  if (!/^pack\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id || '')) errors.push('id must use pack/<slug>');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.slug || '')) errors.push('slug must use lowercase hyphen-case');
  if (manifest.id !== `pack/${manifest.slug}`) errors.push('id must match slug');
  if (path.basename(path.dirname(directory)) !== 'packs' || path.basename(directory) !== manifest.slug) errors.push(`directory must match packs/${manifest.slug}`);
  if (typeof manifest.name !== 'string' || manifest.name.length < 3 || manifest.name.length > 80) errors.push('name must contain 3-80 characters');
  if (typeof manifest.summary !== 'string' || manifest.summary.length < 20 || manifest.summary.length > 180) errors.push('summary must contain 20-180 characters');
  if (!Array.isArray(manifest.outcomes) || manifest.outcomes.length === 0 || new Set(manifest.outcomes).size !== manifest.outcomes.length) errors.push('outcomes must be a non-empty unique array');
  else for (const outcome of manifest.outcomes) if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(outcome)) errors.push(`outcomes contains invalid slug '${outcome}'`);
  const evidence = manifest.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) errors.push('evidence must be an object');
  else {
    const evidenceKeys = Object.keys(evidence);
    for (const key of ['reportSchema', 'ledgerLinkRequired', 'outcomeEvidence']) if (!evidenceKeys.includes(key)) errors.push(`evidence is missing required property '${key}'`);
    for (const key of evidenceKeys) if (!['reportSchema', 'ledgerLinkRequired', 'outcomeEvidence'].includes(key)) errors.push(`evidence has unexpected property '${key}'`);
    if (path.resolve(directory, evidence.reportSchema || '') !== path.join(root, 'schema', 'pack-evidence.schema.json')) errors.push('evidence.reportSchema must resolve to schema/pack-evidence.schema.json');
    if (evidence.ledgerLinkRequired !== true) errors.push('evidence.ledgerLinkRequired must be true');
    const mappings = Array.isArray(evidence.outcomeEvidence) ? evidence.outcomeEvidence : [];
    const mappedOutcomes = mappings.map(({ outcome }) => outcome);
    if (new Set(mappedOutcomes).size !== mappedOutcomes.length || !sameMembers(mappedOutcomes, manifest.outcomes || [])) errors.push('evidence.outcomeEvidence must map every outcome exactly once');
    const memberIds = new Set((manifest.members || []).map(({ artifactId }) => artifactId));
    const requiredIds = new Set((manifest.members || []).filter(({ required }) => required).map(({ artifactId }) => artifactId));
    const mappedIds = new Set();
    for (const [index, mapping] of mappings.entries()) {
      const mappingKeys = mapping && typeof mapping === 'object' && !Array.isArray(mapping) ? Object.keys(mapping) : [];
      for (const key of ['outcome', 'memberArtifactIds']) if (!mappingKeys.includes(key)) errors.push(`evidence.outcomeEvidence[${index}] is missing required property '${key}'`);
      for (const key of mappingKeys) if (!['outcome', 'memberArtifactIds'].includes(key)) errors.push(`evidence.outcomeEvidence[${index}] has unexpected property '${key}'`);
      if (!Array.isArray(mapping.memberArtifactIds) || mapping.memberArtifactIds.length === 0 || new Set(mapping.memberArtifactIds).size !== mapping.memberArtifactIds.length) errors.push(`evidence.outcomeEvidence[${index}].memberArtifactIds must be non-empty and unique`);
      for (const artifactId of mapping.memberArtifactIds || []) {
        mappedIds.add(artifactId);
        if (!memberIds.has(artifactId)) errors.push(`evidence.outcomeEvidence[${index}] references non-member '${artifactId}'`);
      }
    }
    for (const artifactId of requiredIds) if (!mappedIds.has(artifactId)) errors.push(`evidence outcome mapping omits required member '${artifactId}'`);
  }
  if (!existsSync(path.join(directory, 'evaluations', 'behavioral.json'))) errors.push('pack requires evaluations/behavioral.json');
  if (!Array.isArray(manifest.members) || manifest.members.length < 2) {
    errors.push('members must contain at least two artifacts');
    return errors;
  }
  const ids = new Set();
  const byId = new Map(artifacts.map((item) => [item.manifest.id, item]));
  const hookFanout = new Map();
  for (const [index, member] of manifest.members.entries()) {
    if (!member || typeof member !== 'object') {
      errors.push(`members[${index}] must be an object`);
      continue;
    }
    const memberKeys = Object.keys(member);
    for (const key of ['artifactId', 'role', 'required']) if (!memberKeys.includes(key)) errors.push(`members[${index}] is missing required property '${key}'`);
    for (const key of memberKeys) if (!['artifactId', 'role', 'required'].includes(key)) errors.push(`members[${index}] has unexpected property '${key}'`);
    if (typeof member.artifactId !== 'string' || !/^(skill|hook|subagent|command|context|mcp-server)\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(member.artifactId)) errors.push(`members[${index}].artifactId is invalid`);
    if (!knownIds.has(member.artifactId)) errors.push(`members[${index}] references unknown artifact '${member.artifactId}'`);
    if (ids.has(member.artifactId)) errors.push(`members repeats '${member.artifactId}'`);
    ids.add(member.artifactId);
    if (!Object.hasOwn(PACK_ROLE_KINDS, member.role)) errors.push(`members[${index}].role is invalid`);
    if (typeof member.required !== 'boolean') errors.push(`members[${index}].required must be boolean`);
    const artifact = byId.get(member.artifactId)?.manifest;
    if (artifact && PACK_ROLE_KINDS[member.role] && !roleMatchesArtifact(member.role, artifact)) {
      const expectedKinds = [...PACK_ROLE_KINDS[member.role]].join(' or ');
      errors.push(`${member.role} member '${member.artifactId}' must be an operationally compatible ${expectedKinds}`);
    }
  }
  const workflow = analyzePackWorkflow(manifest, artifacts);
  if (!workflow.criteria.crossKindRequiredWorkflow) errors.push('pack required members must compose at least two artifact kinds');
  if (!workflow.criteria.requiredProcedure) errors.push('pack requires a required procedure skill');
  if (!workflow.criteria.independentRequiredAssurance) errors.push('pack requires a required subagent specialist or verifier');
  if (!workflow.criteria.compositionConnected) errors.push('pack members must form one composesWith-connected workflow');
  for (const pair of workflow.incompatiblePairs) {
    errors.push(`pack members '${pair.left}' and '${pair.right}' are incompatible via ${pair.relationship}`);
  }
  for (const gap of workflow.missingPrerequisites) {
    errors.push(`required member '${gap.artifactId}' needs required prerequisite '${gap.prerequisiteId}'`);
  }
  if (!workflow.criteria.compatibleInstallCoordinate) errors.push('pack required members have no common installation target and scope');
  for (const { target } of workflow.compatibility) {
    for (const member of manifest.members) {
      const record = byId.get(member.artifactId);
      if (record?.manifest.kind !== 'hook') continue;
      for (const binding of hookBindings(record.adapters[target]?.data)) {
        const boundary = `${target}:${binding.event}:${binding.matcher}`;
        hookFanout.set(boundary, (hookFanout.get(boundary) || 0) + 1);
      }
    }
  }
  for (const [boundary, count] of hookFanout) {
    if (count > MAX_PACK_HOOK_FANOUT) errors.push(`pack hook fan-out ${count} exceeds ${MAX_PACK_HOOK_FANOUT} at '${boundary}'`);
  }
  return errors;
}

export function publicCatalog(artifacts) {
  const items = artifacts
    .map(({ manifest, adapters }) => ({
      id: manifest.id,
      slug: manifest.slug,
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind,
      summary: manifest.summary,
      description: manifest.description,
      domain: manifest.domain,
      category: manifest.category,
      capabilities: manifest.capabilities,
      problems: manifest.problems,
      frameworks: manifest.frameworks,
      languages: manifest.languages,
      lifecycle: manifest.lifecycle,
      risk: manifest.risk,
      risk_reason: manifest.risk_reason,
      license: manifest.license,
      execution: manifest.execution,
      relationships: manifest.relationships,
      operational: manifest.operational,
      refuses: manifest.refuses,
      targets: Object.keys(manifest.adapters).sort(),
      targetCompatibility: Object.fromEntries(Object.entries(adapters).sort(([left], [right]) => left.localeCompare(right))
        .map(([target, adapter]) => [target, {
          stability: adapter.data.stability || 'stable',
          limitations: adapter.data.limitations || [],
          bindings: adapter.data.bindings || []
        }])),
      install: Object.keys(manifest.adapters).sort().map((target) => ({
        target,
        command: `npx @youdede/toolkit add ${manifest.slug} --target ${target} --scope project`
      }))
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    schemaVersion: 1,
    counts: {
      total: items.length,
      skills: items.filter((item) => item.kind === 'skill').length,
      hooks: items.filter((item) => item.kind === 'hook').length,
      subagents: items.filter((item) => item.kind === 'subagent').length
    },
    relationshipGraph: analyzeRelationshipGraph(artifacts),
    artifacts: items
  };
}

export function publicPackCatalog(packs, artifacts) {
  const byId = new Map(artifacts.map((record) => [record.manifest.id, record]));
  const items = packs.map(({ manifest }) => {
    const workflow = analyzePackWorkflow(manifest, artifacts);
    const targets = workflow.compatibility.map(({ target }) => target);
    const hookFanout = new Map();
    for (const target of targets) {
      for (const { artifactId } of manifest.members) {
        const record = byId.get(artifactId);
        if (record?.manifest.kind !== 'hook') continue;
        for (const binding of hookBindings(record.adapters[target]?.data)) {
          const boundary = `${target}:${binding.event}:${binding.matcher}`;
          hookFanout.set(boundary, (hookFanout.get(boundary) || 0) + 1);
        }
      }
    }
    return {
      ...manifest,
      targets,
      targetCompatibility: Object.fromEntries(workflow.compatibility.map(({ target, scopes, optionalUnsupported, optionalUnsupportedByScope }) => [
        target,
        { scopes, optionalUnsupported, optionalUnsupportedByScope }
      ])),
      promotion: {
        eligible: workflow.eligible,
        criteria: workflow.criteria,
        requiredKinds: workflow.requiredKinds,
        roleCounts: workflow.roleCounts
      },
      hookFanout: [...hookFanout].map(([boundary, count]) => ({ boundary, count })).sort((left, right) => right.count - left.count || left.boundary.localeCompare(right.boundary)),
      install: workflow.compatibility.map(({ target, scopes }) => {
        const scope = scopes.includes('project') ? 'project' : scopes[0];
        return {
          target,
          scope,
          command: `npx @youdede/toolkit add-pack ${manifest.slug} --target ${target} --scope ${scope}`
        };
      })
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: 1, count: items.length, packs: items };
}
