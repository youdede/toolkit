import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadArtifacts, resolvePack, ROOT } from './catalog.mjs';
import { readIntegrityManifest, verifyArtifactAttestation } from './integrity.mjs';
import { defaultSettingsPath, resolveConfigRoot, resolveConfigRoots } from './targets.mjs';

const STATE_MODE = 0o600;
const MAX_DISPLACED_FILE_BYTES = 1024 * 1024;
const STATE_LOCK_TIMEOUT_MS = 30_000;
const STATE_LOCK_STALE_MS = 120_000;
const STATE_LOCK_POLL_MS = 25;
const integrityCatalogs = new Map();

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function atomicWrite(file, data, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  const finalMode = mode ?? (existsSync(file) ? statSync(file).mode & 0o777 : 0o644);
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`
  );
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
      0o600
    );
    writeFileSync(descriptor, data);
    fchmodSync(descriptor, finalMode);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    chmodSync(file, finalMode);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertNoSymlinkWithin(root, target, label) {
  if (!within(root, target)) throw new Error(`${label} escapes the installation root`);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} traverses symbolic link '${path.relative(root, current) || '.'}'`);
    }
  }
}

function readJsonOr(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} contains invalid JSON: ${error.message}`);
  }
}

function statePath(configRoot) {
  return path.join(configRoot, '.youdede-toolkit', 'state.json');
}

function loadState(configRoot) {
  const state = readJsonOr(statePath(configRoot), { schemaVersion: 1, installs: {} });
  if (state.schemaVersion !== 1 || !state.installs || typeof state.installs !== 'object') {
    throw new Error(`${statePath(configRoot)} has an unsupported state format`);
  }
  return state;
}

function writeState(configRoot, state) {
  atomicWrite(statePath(configRoot), Buffer.from(`${JSON.stringify(state, null, 2)}\n`), STATE_MODE);
}

function lockPath(configRoot) {
  return path.join(configRoot, '.youdede-toolkit', 'state.lock');
}

function noticePath(configRoot) {
  return path.join(configRoot, '.youdede-toolkit', 'NOTICE.md');
}

// Installing an artifact copies MIT-licensed files into another project, and MIT requires the
// copyright notice to travel with the copy. One generated notice per config root keeps that
// obligation satisfied without stamping a header onto every installed payload.
function renderNotice(state, root) {
  const installs = Object.values(state.installs || {});
  if (!installs.length) return null;
  const seen = new Map();
  for (const install of installs) {
    if (!install.artifactId || seen.has(install.artifactId)) continue;
    seen.set(install.artifactId, install);
  }
  const lines = [
    '# Third-party notices',
    '',
    'The files below were installed by youdede-toolkit and remain under their own licence.',
    'Do not delete this notice while those files are present.',
    ''
  ];
  for (const install of [...seen.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId))) {
    const licence = install.license || 'MIT';
    const authors = Array.isArray(install.authors) && install.authors.length ? install.authors.join(', ') : 'Youdede';
    lines.push(`- \`${install.artifactId}\`${install.version ? ` ${install.version}` : ''} (${licence}; ${authors})`);
  }
  let licenceText = '';
  try { licenceText = readFileSync(path.join(root || ROOT, 'LICENSE'), 'utf8').trimEnd(); } catch {}
  if (licenceText) lines.push('', '## MIT License', '', licenceText);
  return Buffer.from(`${lines.join('\n')}\n`);
}

// ponytail: one coarse lock per config root, held across the whole read-modify-write of
// state.json. Installs are user-initiated and take milliseconds, so contention is a parallel
// script rather than a hot path. Move to per-key locking only if that stops being true.
function withStateLock(configRoot, operation) {
  const file = lockPath(configRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  let descriptor = null;
  for (;;) {
    try {
      descriptor = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, STATE_MODE);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - statSync(file).mtimeMs; } catch { continue; }
      if (age > STATE_LOCK_STALE_MS) {
        // The holder died without releasing. Reclaim rather than block a user forever.
        try { rmSync(file, { force: true }); } catch {}
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`another youdede-toolkit process holds ${file}; wait for it to finish or delete the lock`);
      }
      sleepBriefly();
    }
  }
  try {
    writeFileSync(descriptor, `${process.pid}\n`);
    closeSync(descriptor);
    descriptor = null;
    return operation();
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try { rmSync(file, { force: true }); } catch {}
  }
}

function sleepBriefly() {
  // Synchronous because the whole installer is synchronous; Atomics.wait blocks without spinning.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STATE_LOCK_POLL_MS);
}

function publishedIntegrity(root) {
  if (!integrityCatalogs.has(root)) integrityCatalogs.set(root, readIntegrityManifest(root));
  return integrityCatalogs.get(root);
}

function assertPublishedIntegrity(record) {
  if (path.resolve(record.root) !== path.resolve(ROOT)) return null;
  const catalog = publishedIntegrity(record.root);
  const expected = catalog.artifacts.find(({ artifactId }) => artifactId === record.manifest.id);
  const findings = verifyArtifactAttestation(record, expected);
  if (findings.length > 0) {
    const finding = findings[0];
    throw new Error(`${record.manifest.id} failed published integrity verification (${finding.status}: ${finding.path})`);
  }
  return { algorithm: catalog.algorithm, digest: expected.digest, integrityId: expected.integrityId };
}

export function runtimeDisclosure(record, target, scope, adapter = record.adapters[target]?.data) {
  const automaticExecution = record.manifest.kind === 'hook';
  const dependencies = [...new Set((record.manifest.execution?.entrypoints || [])
    .map(({ runtime }) => runtime)
    .filter((runtime) => runtime && runtime !== 'none' && runtime !== 'runtime'))].sort();
  return {
    automaticExecution,
    behavior: record.manifest.operational?.behavior || 'unspecified',
    failurePolicy: record.manifest.operational?.failurePolicy || 'unspecified',
    dataRetention: record.manifest.operational?.dataRetention || 'unspecified',
    runtimeDependencies: dependencies,
    activation: target === 'opencode' && automaticExecution ? 'Reload OpenCode after installation or removal.' : 'Target-native discovery applies.',
    trustBoundary: target === 'opencode' && automaticExecution
      ? `${scope} OpenCode plugins execute local code automatically; project plugins have no toolkit-enforced workspace-trust prompt.`
      : (target === 'cursor' && automaticExecution
          ? 'Cursor project hooks require a trusted workspace; user hooks are unavailable in Cursor Cloud.'
          : (automaticExecution ? 'Installed hooks execute automatically when their declared native event and matcher apply.' : 'The artifact runs only when selected or invoked by the target runtime.')),
    limitations: [...(adapter?.limitations || [])]
  };
}

function installOwner(options = {}) {
  const owner = options.owner || 'direct';
  if (owner !== 'direct' && !/^pack:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(owner)) {
    throw new Error(`invalid installation owner '${owner}'`);
  }
  return owner;
}

function recordedOwners(install) {
  if (!install) return [];
  return Array.isArray(install.owners) && install.owners.length > 0 ? install.owners : ['direct'];
}

function displacedRecord(file, relative) {
  const metadata = lstatSync(file);
  if (!metadata.isFile()) throw new Error(`${relative} is not a regular file and cannot be replaced safely`);
  if (metadata.size > MAX_DISPLACED_FILE_BYTES) {
    throw new Error(`${relative} is unmanaged and exceeds the ${MAX_DISPLACED_FILE_BYTES}-byte reversible replacement limit; move it before installing`);
  }
  const data = readFileSync(file);
  return {
    path: relative,
    bytes: data.length,
    sha256: sha256(data),
    mode: metadata.mode & 0o777,
    dataBase64: data.toString('base64')
  };
}

function displacedData(record) {
  if (!record || typeof record.path !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256 || '')
    || !Number.isInteger(record.bytes) || record.bytes < 0 || typeof record.dataBase64 !== 'string') {
    throw new Error(`installation state contains an invalid displaced-file backup for '${record?.path || 'unknown'}'`);
  }
  const data = Buffer.from(record.dataBase64, 'base64');
  if (data.length !== record.bytes || sha256(data) !== record.sha256) {
    throw new Error(`installation state contains a corrupt displaced-file backup for '${record.path}'`);
  }
  return data;
}

function restoreDisplaced(configRoot, record) {
  const destination = path.resolve(configRoot, record.path);
  if (!within(configRoot, destination)) throw new Error(`displaced-file backup path '${record.path}' escapes the installation root`);
  assertNoSymlinkWithin(configRoot, destination, `displaced-file destination '${record.path}'`);
  atomicWrite(destination, displacedData(record), Number.isInteger(record.mode) ? record.mode & 0o777 : 0o644);
}

function settingsPath(target, configRoot, adapter = null, scope = 'project', kind = null) {
  const relative = adapter?.settingsPatch?.path;
  if (!relative) return defaultSettingsPath(target, configRoot, scope, kind);
  const resolved = path.resolve(configRoot, relative);
  if (!within(configRoot, resolved)) throw new Error(`settings patch path '${relative}' escapes the installation root`);
  return resolved;
}

function replaceTokens(value, tokens) {
  if (typeof value === 'string') {
    return Object.entries(tokens).reduce((output, [key, replacement]) => output.replaceAll(`{${key}}`, replacement), value);
  }
  if (Array.isArray(value)) return value.map((entry) => replaceTokens(entry, tokens));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceTokens(entry, tokens)]));
  }
  return value;
}

function walkFiles(source, relative = '') {
  const absolute = path.join(source, relative);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink()) throw new Error(`adapter source contains symbolic link '${relative || path.basename(source)}'`);
  if (metadata.isFile()) return [relative];
  if (!metadata.isDirectory()) throw new Error(`adapter source contains unsupported file '${relative || path.basename(source)}'`);
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => walkFiles(source, path.join(relative, entry.name)))
    .sort();
}

function buildFilePlan(record, adapter, configRoot) {
  const tokens = { slug: record.manifest.slug };
  const plan = [];
  for (const mapping of adapter.files) {
    const sourceRoot = mapping.root === 'package' ? (record.root || ROOT) : record.directory;
    const source = path.resolve(sourceRoot, mapping.from);
    if (!within(sourceRoot, source) || !existsSync(source)) {
      if (mapping.optional) continue;
      throw new Error(`missing adapter source '${mapping.from}'`);
    }
    const baseDestination = path.resolve(configRoot, replaceTokens(mapping.to, tokens));
    if (!within(configRoot, baseDestination)) throw new Error(`unsafe adapter destination '${mapping.to}'`);
    const sourceStat = lstatSync(source);
    if (sourceStat.isSymbolicLink()) throw new Error(`adapter source '${mapping.from}' is a symbolic link`);
    const leaves = sourceStat.isFile() ? [''] : walkFiles(source);
    for (const leaf of leaves) {
      const sourceFile = leaf ? path.join(source, leaf) : source;
      const destination = leaf ? path.join(baseDestination, leaf) : baseDestination;
      if (!within(configRoot, destination)) throw new Error(`unsafe expanded destination '${destination}'`);
      assertNoSymlinkWithin(configRoot, destination, `adapter destination '${path.relative(configRoot, destination)}'`);
      const sourceData = readFileSync(sourceFile);
      plan.push({
        source: sourceFile,
        destination,
        relative: path.relative(configRoot, destination),
        executable: Boolean(mapping.executable),
        sourceSha256: sha256(sourceData),
        bytes: sourceData.length
      });
    }
  }
  return plan;
}

function hookTokens(target, scope, configRoot) {
  return {
    claudeRoot: scope === 'project' ? '${CLAUDE_PROJECT_DIR}/.claude' : '${HOME}/.claude',
    codexRoot: configRoot,
    geminiRoot: scope === 'project' ? '${GEMINI_PROJECT_DIR}/.gemini' : '${HOME}/.gemini',
    cursorRoot: scope === 'project' ? '.cursor' : '${HOME}/.cursor',
    target
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hookMarker(entry) {
  const candidates = [entry?.description, entry?.name, entry?.command, entry?.statusMessage];
  for (const handler of entry?.hooks || []) candidates.push(handler?.description, handler?.name, handler?.command, handler?.statusMessage);
  for (const value of candidates) {
    const match = typeof value === 'string' ? /\[youdede:[a-z0-9]+(?:-[a-z0-9]+)*\]/.exec(value) : null;
    if (match) return match[0];
  }
  return null;
}

function recordedHookMarker(hook) {
  const direct = hookMarker(hook?.entry);
  if (direct) return direct;
  const legacy = typeof hook?.marker === 'string' ? /\[youdede:[a-z0-9]+(?:-[a-z0-9]+)*\]/.exec(hook.marker) : null;
  return legacy?.[0] || null;
}

function prepareSettings(target, adapter, configRoot, scope, kind, ownedInstall, force) {
  if (!adapter.settingsPatch) return { before: null, after: null, hooks: [] };
  const file = settingsPath(target, configRoot, adapter, scope, kind);
  const beforeRaw = existsSync(file) ? readFileSync(file) : null;
  const beforeMode = existsSync(file) ? statSync(file).mode & 0o777 : null;
  const before = readJsonOr(file, {});
  if (!before || Array.isArray(before) || typeof before !== 'object') throw new Error(`${file} must contain a JSON object`);
  const after = structuredClone(before);
  if (target === 'cursor') {
    if (after.version !== undefined && after.version !== 1) throw new Error(`${file} uses unsupported Cursor hooks version '${after.version}'`);
    after.version = 1;
  }
  after.hooks ||= {};
  const installedHooks = [];
  const displacedHooks = structuredClone(ownedInstall?.displacedHooks || []);
  const desiredHooks = Object.entries(adapter.settingsPatch.hooks).flatMap(([event, rawEntries]) =>
    replaceTokens(rawEntries, hookTokens(target, scope, configRoot)).map((entry) => ({ event, entry, marker: hookMarker(entry) })));

  for (const previous of ownedInstall?.hooks || []) {
    const previousMarker = recordedHookMarker(previous);
    const retained = desiredHooks.some(({ event, entry }) => event === previous.event
      && hookMarker(entry) === previousMarker);
    if (retained) continue;
    const configured = Array.isArray(after.hooks?.[previous.event]) ? after.hooks[previous.event] : [];
    const exact = configured.filter((candidate) => sameJson(candidate, previous.entry));
    const marker = configured.filter((candidate) => hookMarker(candidate) === previousMarker);
    if (!force && (exact.length !== 1 || marker.length !== 1)) {
      throw new Error(`settings contain a modified or missing stale '${previousMarker}' entry; use --force to replace it`);
    }
    if (!Array.isArray(after.hooks?.[previous.event])) continue;
    const previousIndex = after.hooks[previous.event].findIndex((candidate) => hookMarker(candidate) === previousMarker);
    after.hooks[previous.event] = after.hooks[previous.event].filter((candidate) => force
      ? hookMarker(candidate) !== previousMarker
      : !sameJson(candidate, previous.entry));
    const displacedIndex = displacedHooks.findIndex((candidate) => candidate.event === previous.event && candidate.marker === previousMarker);
    if (displacedIndex >= 0) {
      const [displaced] = displacedHooks.splice(displacedIndex, 1);
      after.hooks[previous.event].splice(Math.max(0, Math.min(previousIndex, after.hooks[previous.event].length)), 0, displaced.entry);
    }
    if (after.hooks[previous.event].length === 0) delete after.hooks[previous.event];
  }

  for (const [event, rawEntries] of Object.entries(adapter.settingsPatch.hooks)) {
    const entries = replaceTokens(rawEntries, hookTokens(target, scope, configRoot));
    after.hooks[event] ||= [];
    if (!Array.isArray(after.hooks[event])) throw new Error(`${file} hooks.${event} must be an array`);
    for (const entry of entries) {
      const marker = hookMarker(entry);
      if (!marker) throw new Error(`hook settings entry for ${event} has no [youdede:<slug>] marker`);
      const index = after.hooks[event].findIndex((candidate) => hookMarker(candidate) === marker);
      if (index >= 0 && !sameJson(after.hooks[event][index], entry)) {
        const ownedHook = ownedInstall?.hooks?.find((hook) => hook.event === event
          && recordedHookMarker(hook) === marker);
        if (!force && (!ownedHook || !sameJson(after.hooks[event][index], ownedHook.entry))) {
          throw new Error(`settings contain a modified or unmanaged '${marker}' entry; use --force to replace it`);
        }
        if (!ownedHook && !displacedHooks.some((candidate) => candidate.event === event && candidate.marker === marker)) {
          displacedHooks.push({ event, marker, index, entry: structuredClone(after.hooks[event][index]) });
        }
        after.hooks[event][index] = entry;
      } else if (index < 0) {
        after.hooks[event].push(entry);
      }
      installedHooks.push({ event, entry, marker });
    }
  }

  return {
    file,
    before: beforeRaw,
    beforeMode,
    after: Buffer.from(`${JSON.stringify(after, null, 2)}\n`),
    hooks: installedHooks,
    displacedHooks
  };
}

function emptySettingsScaffold(target, settings) {
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') return false;
  return target === 'cursor' ? sameJson(settings, { version: 1 }) : Object.keys(settings).length === 0;
}

function ownersByFile(state, exceptKey) {
  const owners = new Map();
  for (const [key, install] of Object.entries(state.installs)) {
    if (key === exceptKey) continue;
    for (const file of install.files || []) owners.set(file.path, { key, file, install });
  }
  return owners;
}

function restoreFile(file, backup) {
  if (backup === null) {
    if (existsSync(file)) rmSync(file, { force: true });
  } else {
    atomicWrite(file, backup.data, backup.mode);
  }
}

function cleanupEmptyParents(file, stop) {
  let current = path.dirname(file);
  while (within(stop, current) && current !== stop) {
    try {
      if (readdirSync(current).length > 0) break;
      rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

export function resolveArtifact(query, root = ROOT) {
  const artifacts = loadArtifacts(root);
  const matches = artifacts.filter(({ manifest }) => manifest.id === query || manifest.slug === query);
  if (matches.length === 0) throw new Error(`artifact '${query}' was not found`);
  if (matches.length > 1) throw new Error(`artifact slug '${query}' is ambiguous; use a full id`);
  return matches[0];
}

function prepareInstall(query, options = {}) {
  const root = options.root || ROOT;
  const target = options.target || 'claude-code';
  const scope = options.scope || 'project';
  const cwd = options.cwd || process.cwd();
  const force = Boolean(options.force);
  const record = resolveArtifact(query, root);
  const adapter = record.adapters[target]?.data;
  if (!adapter) throw new Error(`${record.manifest.id} does not support ${target}`);
  if (!adapter.scopes.includes(scope)) throw new Error(`${record.manifest.id} does not support ${scope} scope`);
  const integrity = assertPublishedIntegrity(record);

  const configRoot = resolveConfigRoot(target, scope, cwd, record.manifest.kind);
  assertNoSymlinkWithin(configRoot, configRoot, 'installation root');
  assertNoSymlinkWithin(configRoot, statePath(configRoot), 'installation state');
  if (adapter.settingsPatch) assertNoSymlinkWithin(configRoot, settingsPath(target, configRoot, adapter, scope, record.manifest.kind), 'target settings');
  const key = `${target}:${scope}:${record.manifest.id}`;
  const state = loadState(configRoot);
  const ownedInstall = state.installs[key];
  const owners = ownersByFile(state, key);
  const filePlan = buildFilePlan(record, adapter, configRoot);
  const newPaths = new Set(filePlan.map((file) => file.relative));
  const stale = (ownedInstall?.files || []).filter((file) => !newPaths.has(file.path));
  const displacedByPath = new Map((ownedInstall?.displacedFiles || []).map((file) => [file.path, file]));

  for (const item of filePlan) {
    const sharedOwner = owners.get(item.relative);
    if (sharedOwner && (sharedOwner.file.sha256 !== item.sourceSha256
      || Boolean(sharedOwner.file.executable) !== Boolean(item.executable))) {
      throw new Error(`${item.relative} conflicts with ${sharedOwner.key}`);
    }
    if (sharedOwner?.install.displacedFiles?.some((file) => file.path === item.relative)) {
      throw new Error(`${item.relative} cannot be shared because ${sharedOwner.key} replaced an unmanaged file`);
    }
    if (existsSync(item.destination)) {
      const ownedFile = ownedInstall?.files?.find((file) => file.path === item.relative);
      const managedFile = ownedFile || sharedOwner?.file;
      if (!managedFile && !force) {
        throw new Error(`${item.relative} already exists and is unmanaged; use --force to replace it`);
      }
      if (!managedFile && force && !displacedByPath.has(item.relative)) {
        displacedByPath.set(item.relative, displacedRecord(item.destination, item.relative));
      }
      if (managedFile && sha256(readFileSync(item.destination)) !== managedFile.sha256 && !force) {
        throw new Error(`${item.relative} changed since installation; use --force to replace it`);
      }
    }
  }
  for (const item of stale) {
    const absolute = path.join(configRoot, item.path);
    assertNoSymlinkWithin(configRoot, absolute, `stale installed path '${item.path}'`);
    if (existsSync(absolute) && sha256(readFileSync(absolute)) !== item.sha256 && !force) {
      throw new Error(`${item.path} changed since installation; use --force to replace the installation`);
    }
  }

  const settings = prepareSettings(target, adapter, configRoot, scope, record.manifest.kind, ownedInstall, force);
  const displacedFiles = [...displacedByPath.values()].filter(({ path: displacedPath }) => newPaths.has(displacedPath));
  return { record, target, scope, configRoot, key, state, ownedInstall, filePlan, stale, settings, integrity, displacedByPath, displacedFiles };
}

export function planArtifactInstall(query, options = {}) {
  const prepared = prepareInstall(query, options);
  const { record, target, scope, configRoot, filePlan, stale, settings, integrity, displacedByPath } = prepared;
  return {
    artifact: record.manifest,
    target,
    scope,
    configRoot,
    writes: filePlan.map((item) => ({
      path: item.relative,
      bytes: item.bytes,
      sha256: item.sourceSha256,
      executable: item.executable,
      action: displacedByPath.has(item.relative) ? 'replace-reversible' : (existsSync(item.destination) ? 'replace' : 'create')
    })),
    removes: stale.map((item) => ({
      path: item.path,
      action: displacedByPath.has(item.path) ? 'restore-displaced' : 'remove-stale'
    })),
    settings: settings.after ? {
      path: path.relative(configRoot, settings.file),
      action: settings.before === null ? 'create' : 'merge',
      changed: settings.before === null || !settings.before.equals(settings.after)
    } : null,
    integrity,
    runtime: runtimeDisclosure(record, target, scope),
    state: { path: path.relative(configRoot, statePath(configRoot)), action: 'update' }
  };
}

export function installArtifact(query, options = {}) {
  // state.json is a read-modify-write across the whole plan-copy-record sequence, so the lock
  // is taken before prepareInstall reads it. installPack delegates here per member, one at a
  // time, so the lock is acquired and released per artifact and never nests.
  const target = options.target || 'claude-code';
  const scope = options.scope || 'project';
  const record = resolveArtifact(query, options.root || ROOT);
  // Reject unsupported target/scope combinations before taking the lock, so a refused install
  // never creates the config root it was refused for.
  const adapter = record.adapters[target]?.data;
  if (!adapter) throw new Error(`${record.manifest.id} does not support ${target}`);
  if (!adapter.scopes.includes(scope)) throw new Error(`${record.manifest.id} does not support ${scope} scope`);
  const configRoot = resolveConfigRoot(target, scope, options.cwd || process.cwd(), record.manifest.kind);
  return withStateLock(configRoot, () => installArtifactLocked(query, options));
}

function installArtifactLocked(query, options = {}) {
  const prepared = prepareInstall(query, options);
  const { record, target, scope, configRoot, key, state, ownedInstall, filePlan, stale, settings, displacedByPath, displacedFiles } = prepared;
  const owner = installOwner(options);
  const backups = new Map();
  const touched = [];
  const previousState = existsSync(statePath(configRoot))
    ? { data: readFileSync(statePath(configRoot)), mode: statSync(statePath(configRoot)).mode & 0o777 }
    : null;

  try {
    for (const item of [...filePlan, ...stale.map((entry) => ({ destination: path.join(configRoot, entry.path) }))]) {
      if (backups.has(item.destination)) continue;
      backups.set(item.destination, existsSync(item.destination)
        ? { data: readFileSync(item.destination), mode: statSync(item.destination).mode }
        : null);
    }

    for (const item of filePlan) {
      const data = readFileSync(item.source);
      if (sha256(data) !== item.sourceSha256) throw new Error(`${item.relative} changed while the installation was being prepared`);
      atomicWrite(item.destination, data, item.executable ? 0o755 : undefined);
      touched.push(item.destination);
    }
    for (const item of stale) {
      const absolute = path.join(configRoot, item.path);
      const displaced = displacedByPath.get(item.path);
      if (displaced) restoreDisplaced(configRoot, displaced);
      else if (existsSync(absolute)) rmSync(absolute, { force: true });
      touched.push(absolute);
    }
    if (settings.after) atomicWrite(settings.file, settings.after);

    state.installs[key] = {
      artifactId: record.manifest.id,
      slug: record.manifest.slug,
      version: record.manifest.version,
      kind: record.manifest.kind,
      target,
      scope,
      files: filePlan.map((item) => ({
        path: item.relative,
        sha256: item.sourceSha256,
        executable: item.executable
      })),
      displacedFiles,
      hooks: settings.hooks,
      displacedHooks: settings.displacedHooks || [],
      settingsPath: settings.after ? path.relative(configRoot, settings.file) : null,
      settingsCreated: Boolean(ownedInstall?.settingsCreated || (settings.after && settings.before === null)),
      license: record.manifest.license,
      authors: record.manifest.authors,
      owners: [...new Set([...recordedOwners(ownedInstall), owner])].sort()
    };
    writeState(configRoot, state);

    const notice = noticePath(configRoot);
    if (!backups.has(notice)) {
      backups.set(notice, existsSync(notice) ? { data: readFileSync(notice), mode: statSync(notice).mode } : null);
    }
    const rendered = renderNotice(state, record.root || ROOT);
    if (rendered) {
      atomicWrite(notice, rendered, 0o644);
      touched.push(notice);
    }
  } catch (error) {
    for (const destination of [...touched].reverse()) restoreFile(destination, backups.get(destination));
    if (settings.after) restoreFile(settings.file, settings.before === null ? null : { data: settings.before, mode: settings.beforeMode });
    restoreFile(statePath(configRoot), previousState);
    throw error;
  }

  return {
    artifact: record.manifest,
    configRoot,
    files: filePlan.map((item) => item.destination),
    settingsFile: settings.after ? settings.file : null,
    integrity: prepared.integrity,
    runtime: runtimeDisclosure(record, target, scope)
  };
}

export function removeArtifact(query, options = {}) {
  // Resolve the owning root read-only, then redo the search under the lock so the state the
  // removal acts on is the state it recorded its decisions from.
  const target = options.target || 'claude-code';
  const scope = options.scope || 'project';
  const cwd = options.cwd || process.cwd();
  let owningRoot = null;
  for (const candidateRoot of resolveConfigRoots(target, scope, cwd)) {
    if (!existsSync(statePath(candidateRoot))) continue;
    const candidateState = loadState(candidateRoot);
    if (Object.entries(candidateState.installs).some(([key, install]) => key.startsWith(`${target}:${scope}:`)
      && (install.artifactId === query || install.slug === query))) {
      owningRoot = candidateRoot;
      break;
    }
  }
  if (!owningRoot) {
    let kind = null;
    try { kind = resolveArtifact(query, options.root || ROOT).manifest.kind; } catch {}
    owningRoot = resolveConfigRoot(target, scope, cwd, kind);
  }
  return withStateLock(owningRoot, () => removeArtifactLocked(query, options));
}

function removeArtifactLocked(query, options = {}) {
  const root = options.root || ROOT;
  const target = options.target || 'claude-code';
  const scope = options.scope || 'project';
  const cwd = options.cwd || process.cwd();
  const force = Boolean(options.force);
  let record = null;
  let resolutionError = null;
  try { record = resolveArtifact(query, root); } catch (error) { resolutionError = error; }

  const installedMatches = [];
  for (const candidateRoot of resolveConfigRoots(target, scope, cwd)) {
    assertNoSymlinkWithin(candidateRoot, candidateRoot, 'installation root');
    assertNoSymlinkWithin(candidateRoot, statePath(candidateRoot), 'installation state');
    const candidateState = loadState(candidateRoot);
    for (const [key, install] of Object.entries(candidateState.installs)) {
      if (key.startsWith(`${target}:${scope}:`) && (install.artifactId === query || install.slug === query)) {
        installedMatches.push({ configRoot: candidateRoot, state: candidateState, key, install });
      }
    }
  }
  if (installedMatches.length > 1) throw new Error(`installed artifact '${query}' is ambiguous for ${target}/${scope}; use a full id`);
  if (!record && installedMatches.length === 0) throw resolutionError;

  const matched = installedMatches[0];
  const configRoot = matched?.configRoot || resolveConfigRoot(target, scope, cwd, record.manifest.kind);
  assertNoSymlinkWithin(configRoot, configRoot, 'installation root');
  assertNoSymlinkWithin(configRoot, statePath(configRoot), 'installation state');
  const state = matched?.state || loadState(configRoot);
  const key = matched?.key || `${target}:${scope}:${record.manifest.id}`;
  const installed = matched?.install || state.installs[key];
  const artifact = record?.manifest || {
    id: installed?.artifactId,
    slug: installed?.slug,
    version: installed?.version,
    kind: installed?.kind || String(installed?.artifactId || '').split('/')[0] || 'unavailable'
  };
  if (!installed) throw new Error(`${artifact.id} is not recorded as installed for ${target}/${scope}`);
  const fallbackAdapter = record?.adapters?.[target]?.data;
  const resolvedSettingsPath = (installed.hooks || []).length
    ? path.resolve(configRoot, installed.settingsPath || path.relative(configRoot, settingsPath(target, configRoot, fallbackAdapter, scope, artifact.kind)))
    : null;
  if (resolvedSettingsPath) assertNoSymlinkWithin(configRoot, resolvedSettingsPath, 'target settings');
  const owner = installOwner(options);
  const owners = recordedOwners(installed);
  if (!owners.includes(owner)) throw new Error(`${artifact.id} is not owned by '${owner}' for ${target}/${scope}`);
  if (owners.length > 1) {
    installed.owners = owners.filter((candidate) => candidate !== owner);
    writeState(configRoot, state);
    return { artifact, configRoot, removed: [], ownershipReleased: owner };
  }

  for (const file of installed.files || []) {
    const absolute = path.join(configRoot, file.path);
    if (!within(configRoot, absolute)) throw new Error(`state contains unsafe path '${file.path}'`);
    assertNoSymlinkWithin(configRoot, absolute, `installed path '${file.path}'`);
    if (existsSync(absolute) && sha256(readFileSync(absolute)) !== file.sha256 && !force) {
      throw new Error(`${file.path} changed since installation; use --force to remove it`);
    }
  }
  const displacedByPath = new Map();
  for (const displaced of installed.displacedFiles || []) {
    const absolute = path.resolve(configRoot, displaced.path || '');
    if (!within(configRoot, absolute)) throw new Error(`state contains unsafe displaced-file path '${displaced.path}'`);
    displacedData(displaced);
    displacedByPath.set(displaced.path, displaced);
  }

  const settingsFile = resolvedSettingsPath;
  const settingsBefore = settingsFile && existsSync(settingsFile)
    ? { data: readFileSync(settingsFile), mode: statSync(settingsFile).mode & 0o777 }
    : null;
  let settingsAfter = null;
  let deleteSettingsFile = false;
  if ((installed.hooks || []).length) {
    const settings = readJsonOr(settingsFile, {});
    for (const hook of installed.hooks) {
      const { event, entry } = hook;
      const entryMarker = recordedHookMarker(hook);
      if (!entryMarker) {
        throw new Error(`installation state records a '${event}' hook with no [youdede:<slug>] marker; repair or delete ${statePath(configRoot)} before removing`);
      }
      const configured = Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [];
      const exact = configured.filter((candidate) => sameJson(candidate, entry));
      const marker = configured.filter((candidate) => hookMarker(candidate) === entryMarker);
      if (!force && (exact.length !== 1 || marker.length !== 1)) {
        throw new Error(`settings entry '${entryMarker}' changed since installation; use --force to remove it`);
      }
      if (!Array.isArray(settings.hooks?.[event])) continue;
      settings.hooks[event] = settings.hooks[event].filter((candidate) => force
        ? hookMarker(candidate) !== entryMarker
        : !sameJson(candidate, entry));
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    for (const displaced of installed.displacedHooks || []) {
      settings.hooks ||= {};
      settings.hooks[displaced.event] ||= [];
      const configured = settings.hooks[displaced.event];
      if (configured.some((candidate) => hookMarker(candidate) === displaced.marker)) {
        if (!force) throw new Error(`settings already contain displaced marker '${displaced.marker}'`);
        settings.hooks[displaced.event] = configured.filter((candidate) => hookMarker(candidate) !== displaced.marker);
      }
      settings.hooks[displaced.event].splice(
        Math.max(0, Math.min(Number.isInteger(displaced.index) ? displaced.index : settings.hooks[displaced.event].length, settings.hooks[displaced.event].length)),
        0,
        displaced.entry
      );
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    settingsAfter = Buffer.from(`${JSON.stringify(settings, null, 2)}\n`);
    if (installed.settingsCreated) {
      const successor = Object.entries(state.installs).find(([candidateKey, candidate]) => candidateKey !== key
        && (candidate.hooks || []).length > 0
        && candidate.settingsPath === installed.settingsPath);
      if (successor) successor[1].settingsCreated = true;
      else deleteSettingsFile = emptySettingsScaffold(target, settings);
    }
  }

  const fileBackups = new Map();
  const sharedPaths = new Set();
  for (const [candidateKey, candidate] of Object.entries(state.installs)) {
    if (candidateKey === key) continue;
    for (const file of candidate.files || []) {
      if ((installed.files || []).some((ownedFile) => ownedFile.path === file.path)) sharedPaths.add(file.path);
    }
  }
  const previousState = {
    data: readFileSync(statePath(configRoot)),
    mode: statSync(statePath(configRoot)).mode & 0o777
  };
  try {
    for (const file of installed.files || []) {
      const absolute = path.join(configRoot, file.path);
      if (sharedPaths.has(file.path)) continue;
      fileBackups.set(absolute, existsSync(absolute)
        ? { data: readFileSync(absolute), mode: statSync(absolute).mode & 0o777 }
        : null);
      const displaced = displacedByPath.get(file.path);
      if (displaced) restoreDisplaced(configRoot, displaced);
      else if (existsSync(absolute)) rmSync(absolute, { force: true });
    }
    if (settingsAfter) {
      if (deleteSettingsFile) rmSync(settingsFile, { force: true });
      else atomicWrite(settingsFile, settingsAfter);
    }
    delete state.installs[key];
    writeState(configRoot, state);

    // Keep the generated notice in step with what is still installed, and drop it once the
    // last artifact leaves so uninstall does not litter the project.
    const notice = noticePath(configRoot);
    if (!fileBackups.has(notice)) {
      fileBackups.set(notice, existsSync(notice) ? { data: readFileSync(notice), mode: statSync(notice).mode } : null);
    }
    const rendered = renderNotice(state, ROOT);
    if (rendered) atomicWrite(notice, rendered, 0o644);
    else if (existsSync(notice)) rmSync(notice, { force: true });
  } catch (error) {
    for (const [absolute, backup] of fileBackups) restoreFile(absolute, backup);
    if (settingsFile) restoreFile(settingsFile, settingsBefore);
    restoreFile(statePath(configRoot), previousState);
    throw error;
  }

  for (const file of installed.files || []) {
    if (!sharedPaths.has(file.path)) cleanupEmptyParents(path.join(configRoot, file.path), configRoot);
  }
  return {
    artifact,
    configRoot,
    removed: (installed.files || []).filter((file) => !sharedPaths.has(file.path)).map((file) => path.join(configRoot, file.path))
  };
}

export function planPackInstall(query, options = {}) {
  const root = options.root || ROOT;
  const pack = resolvePack(query, root).manifest;
  const target = options.target || 'claude-code';
  const plans = [];
  for (const member of pack.members) {
    try {
      plans.push({ member, plan: planArtifactInstall(member.artifactId, options) });
    } catch (error) {
      if (member.required) throw new Error(`${pack.id}: required member ${member.artifactId} cannot install for ${target}: ${error.message}`);
      plans.push({ member, skipped: error.message });
    }
  }
  const mutations = new Map();
  for (const { member, plan } of plans) {
    if (!plan) continue;
    for (const mutation of [...plan.writes, ...plan.removes]) {
      const key = `${plan.configRoot}\0${mutation.path}`;
      const previous = mutations.get(key);
      const identicalSharedWrite = typeof mutation.sha256 === 'string' && previous?.sha256 === mutation.sha256;
      if (previous && previous.artifactId !== member.artifactId && !identicalSharedWrite) {
        throw new Error(`${pack.id}: members ${previous.artifactId} and ${member.artifactId} both mutate '${mutation.path}'`);
      }
      mutations.set(key, { artifactId: member.artifactId, sha256: mutation.sha256 });
    }
  }
  return { pack, target, scope: options.scope || 'project', members: plans };
}

function snapshotFiles(files) {
  const snapshots = new Map();
  for (const file of files) {
    if (snapshots.has(file)) continue;
    snapshots.set(file, existsSync(file)
      ? { data: readFileSync(file), mode: statSync(file).mode & 0o777 }
      : null);
  }
  return snapshots;
}

function restoreFiles(snapshots, configRoots) {
  for (const [file, snapshot] of [...snapshots.entries()].reverse()) restoreFile(file, snapshot);
  for (const [file, snapshot] of snapshots) {
    if (snapshot !== null) continue;
    const configRoot = configRoots.find((candidate) => within(candidate, file));
    if (configRoot) cleanupEmptyParents(file, configRoot);
  }
}

function packMutationPaths(planned) {
  const files = new Set();
  const roots = new Set();
  for (const { plan } of planned.members) {
    if (!plan) continue;
    roots.add(plan.configRoot);
    for (const mutation of [...plan.writes, ...plan.removes]) files.add(path.join(plan.configRoot, mutation.path));
    if (plan.settings) files.add(path.join(plan.configRoot, plan.settings.path));
    files.add(path.join(plan.configRoot, plan.state.path));
  }
  return { files, roots };
}

export function installPack(query, options = {}) {
  const planned = planPackInstall(query, options);
  const owner = `pack:${planned.pack.slug}`;
  const installed = [];
  const mutations = packMutationPaths(planned);
  const snapshots = snapshotFiles(mutations.files);
  try {
    for (const item of planned.members) {
      if (item.skipped) continue;
      installed.push(installArtifact(item.member.artifactId, { ...options, owner }));
    }
  } catch (error) {
    restoreFiles(snapshots, [...mutations.roots]);
    throw new Error(`${planned.pack.id} installation failed: ${error.message}`);
  }
  return { pack: planned.pack, target: planned.target, scope: planned.scope, installed, skipped: planned.members.filter((item) => item.skipped) };
}

export function removePack(query, options = {}) {
  const root = options.root || ROOT;
  let pack;
  try {
    pack = resolvePack(query, root).manifest;
  } catch (error) {
    if (!/was not found/.test(error.message)) throw error;
    const slug = query.startsWith('pack/') ? query.slice('pack/'.length) : query;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw error;
    pack = { id: `pack/${slug}`, slug, version: 'unavailable', members: [] };
  }
  const target = options.target || 'claude-code';
  const scope = options.scope || 'project';
  const cwd = options.cwd || process.cwd();
  const owner = `pack:${pack.slug}`;
  const removable = [];
  const removableKeys = new Set();
  for (const configRoot of resolveConfigRoots(target, scope, cwd)) {
    const state = loadState(configRoot);
    for (const [key, installed] of Object.entries(state.installs)) {
      if (!key.startsWith(`${target}:${scope}:`) || !recordedOwners(installed).includes(owner)) continue;
      removable.push({ configRoot, installed });
      removableKeys.add(key);
    }
  }
  if (removable.length === 0) throw new Error(`${pack.id} is not recorded as installed for ${target}/${scope}`);
  const drift = doctor({ target, scope, cwd }).findings.filter((finding) => removableKeys.has(finding.key));
  if (drift.length > 0 && !options.force) {
    throw new Error(`${pack.id}: installed members have drift; use --force after review (${drift.map((item) => `${item.status}:${item.path}`).join(', ')})`);
  }
  const mutationFiles = new Set(removable.map(({ configRoot }) => statePath(configRoot)));
  for (const { configRoot, installed } of removable) {
    for (const file of installed.files || []) {
      const absolute = path.join(configRoot, file.path);
      if (!within(configRoot, absolute)) throw new Error(`${pack.id}: state contains unsafe path '${file.path}'`);
      assertNoSymlinkWithin(configRoot, absolute, `installed path '${file.path}'`);
      mutationFiles.add(absolute);
    }
    if ((installed.hooks || []).length) {
      const kind = installed.kind || String(installed.artifactId || '').split('/')[0] || null;
      mutationFiles.add(path.resolve(configRoot, installed.settingsPath || path.relative(configRoot, defaultSettingsPath(target, configRoot, scope, kind))));
    }
  }
  const snapshots = snapshotFiles(mutationFiles);
  const removed = [];
  try {
    for (const { installed } of removable.toReversed()) {
      removed.push(removeArtifact(installed.artifactId, { ...options, owner }));
    }
  } catch (error) {
    restoreFiles(snapshots, [...new Set(removable.map(({ configRoot }) => configRoot))]);
    throw new Error(`${pack.id} removal failed: ${error.message}`);
  }
  return { pack, target, scope, removed };
}

function doctorRoot(target, scope, configRoot) {
  assertNoSymlinkWithin(configRoot, configRoot, 'installation root');
  assertNoSymlinkWithin(configRoot, statePath(configRoot), 'installation state');
  const state = loadState(configRoot);
  const findings = [];
  const settingsByPath = new Map();
  for (const [key, install] of Object.entries(state.installs)) {
    for (const displaced of install.displacedFiles || []) {
      try { displacedData(displaced); } catch {
        findings.push({ key, path: displaced?.path || '.youdede-toolkit/state.json', status: 'displaced-backup-invalid' });
      }
    }
    for (const file of install.files || []) {
      const absolute = path.join(configRoot, file.path);
      if (!within(configRoot, absolute)) {
        findings.push({ key, path: file.path, status: 'unsafe-state-path' });
        continue;
      }
      try {
        assertNoSymlinkWithin(configRoot, absolute, `installed path '${file.path}'`);
      } catch {
        findings.push({ key, path: file.path, status: 'symbolic-link' });
        continue;
      }
      if (!existsSync(absolute)) findings.push({ key, path: file.path, status: 'missing' });
      else if (sha256(readFileSync(absolute)) !== file.sha256) findings.push({ key, path: file.path, status: 'modified' });
    }
    if ((install.hooks || []).length) {
      const kind = install.kind || String(install.artifactId || '').split('/')[0] || null;
      const relativeSettings = install.settingsPath || path.relative(configRoot, defaultSettingsPath(target, configRoot, scope, kind));
      const absoluteSettings = path.resolve(configRoot, relativeSettings);
      let settings = settingsByPath.get(absoluteSettings);
      if (settings === undefined) {
        try {
          settings = readJsonOr(absoluteSettings, {});
          if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error('settings root is not an object');
          settingsByPath.set(absoluteSettings, settings);
        } catch {
          settingsByPath.set(absoluteSettings, null);
          findings.push({ key: `${target}:${scope}:settings`, path: relativeSettings, status: 'settings-invalid' });
          settings = null;
        }
      }
      if (!settings) continue;
      for (const hook of install.hooks || []) {
        const { event, entry } = hook;
        const entryMarker = recordedHookMarker(hook);
        if (!entryMarker) {
          findings.push({ key, path: `${relativeSettings}#hooks.${event}`, status: 'hook-state-unmarked' });
          continue;
        }
        const configured = Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [];
        const exact = configured.filter((candidate) => sameJson(candidate, entry));
        const marker = configured.filter((candidate) => hookMarker(candidate) === entryMarker);
        if (exact.length === 0) findings.push({
          key,
          path: `${relativeSettings}#hooks.${event}`,
          status: marker.length > 0 ? 'hook-settings-modified' : 'hook-settings-missing'
        });
        else if (exact.length > 1) findings.push({ key, path: `${relativeSettings}#hooks.${event}`, status: 'hook-settings-duplicate' });
      }
    }
  }
  return { configRoot, installs: Object.keys(state.installs).length, findings };
}

export function doctor(options = {}) {
  const target = options.target || 'claude-code';
  const scope = options.scope || 'project';
  const cwd = options.cwd || process.cwd();
  const possibleRoots = resolveConfigRoots(target, scope, cwd);
  const activeRoots = possibleRoots.filter((configRoot) => existsSync(statePath(configRoot)));
  const roots = activeRoots.length > 0 ? activeRoots : [resolveConfigRoot(target, scope, cwd, 'skill')];
  const reports = roots.map((configRoot) => doctorRoot(target, scope, configRoot));
  if (reports.length === 1) return reports[0];
  return {
    configRoot: null,
    configRoots: reports.map((report) => report.configRoot),
    installs: reports.reduce((total, report) => total + report.installs, 0),
    findings: reports.flatMap((report) => report.findings)
  };
}
