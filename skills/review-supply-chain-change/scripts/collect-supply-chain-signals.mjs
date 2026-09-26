#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_FILE_COUNT = 64;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
// Real package-lock.json files often exceed 512 KiB, so one file may use the whole budget.
export const MAX_FILE_BYTES = MAX_TOTAL_BYTES;
export const MAX_SIGNALS_PER_FILE = 200;

const MANIFEST_NAMES = new Set([
  'package.json',
  'composer.json',
  'pyproject.toml',
  'cargo.toml',
  'gemfile',
  'go.mod',
  'requirements.txt'
]);

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'cargo.lock',
  'poetry.lock',
  'uv.lock',
  'gemfile.lock',
  'go.sum'
]);

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('file paths must be non-empty strings');
  const portable = value.replaceAll('\\', '/').replace(/^\.\//, '');
  const normalized = path.posix.normalize(portable);
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`file path must stay inside the root: ${value}`);
  }
  return normalized;
}

function fileType(relativePath) {
  const lowerPath = relativePath.toLowerCase();
  const basename = path.posix.basename(lowerPath);
  if (/^(?:\.github\/workflows\/).+\.ya?ml$/.test(lowerPath)) return 'github-actions-workflow';
  if (MANIFEST_NAMES.has(basename)) return basename === 'package.json' ? 'npm-manifest' : 'manifest';
  if (LOCKFILE_NAMES.has(basename)) {
    return basename === 'package-lock.json' || basename === 'npm-shrinkwrap.json' ? 'npm-lockfile' : 'lockfile';
  }
  throw new Error(`unsupported supply-chain evidence file: ${relativePath}`);
}

function parseJson(text, relativePath) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('top-level value must be an object');
    return value;
  } catch (error) {
    throw new Error(`${relativePath} is not valid object JSON: ${error.message}`);
  }
}

function classifyDependencySource(specifier) {
  if (typeof specifier !== 'string') return 'non-string';
  const value = specifier.trim().toLowerCase();
  if (value.startsWith('workspace:')) return 'workspace';
  if (value.startsWith('file:') || value.startsWith('link:') || value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) return 'local-path';
  if (value.startsWith('npm:')) return 'registry-alias';
  if (value.startsWith('git:') || value.startsWith('git+') || value.startsWith('github:') || /^(?:[^/@\s]+\/[^/@\s]+)(?:#.*)?$/.test(value)) return 'git';
  if (value.startsWith('http://')) return 'unencrypted-remote';
  if (value.startsWith('https://')) return 'remote-archive';
  return 'registry-range';
}

function boundedText(value, limit = 180) {
  return String(value).slice(0, limit);
}

function redactReference(value) {
  if (value.includes('${{')) return '<dynamic-expression>';
  if (value.includes('://')) {
    try {
      const parsed = new URL(value);
      return `${parsed.protocol}//${parsed.hostname}/<redacted>`;
    } catch {
      return '<remote-reference>';
    }
  }
  return boundedText(value);
}

function collectPackageManifest(text, relativePath) {
  const document = parseJson(text, relativePath);
  const signals = [];
  if (Object.hasOwn(document, 'packageManager')) {
    signals.push({
      ruleId: 'SC_PACKAGE_MANAGER_DECLARATION',
      valueType: typeof document.packageManager,
      manager: typeof document.packageManager === 'string' ? /^([a-z0-9-]+)@/i.exec(document.packageManager)?.[1]?.toLowerCase() || null : null,
      hasVersion: typeof document.packageManager === 'string' && document.packageManager.includes('@')
    });
  }

  const scripts = document.scripts;
  if (scripts !== undefined && (!scripts || typeof scripts !== 'object' || Array.isArray(scripts))) {
    signals.push({ ruleId: 'SC_SCRIPTS_NON_OBJECT' });
  } else if (scripts) {
    // The scripts `npm install` runs for the project, in npm's documented order.
    for (const name of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
      if (Object.hasOwn(scripts, name)) {
        signals.push({ ruleId: 'SC_INSTALL_LIFECYCLE_SCRIPT', name, valueType: typeof scripts[name] });
      }
    }
  }

  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = document[section];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      signals.push({ ruleId: 'SC_DEPENDENCY_SECTION_NON_OBJECT', section });
      continue;
    }
    for (const name of Object.keys(dependencies).sort()) {
      const sourceType = classifyDependencySource(dependencies[name]);
      if (sourceType !== 'registry-range' && sourceType !== 'workspace') {
        signals.push({ ruleId: 'SC_DEPENDENCY_SOURCE', section, name: boundedText(name), sourceType });
      }
    }
  }
  return signals;
}

function classifyResolution(value) {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  if (lower.startsWith('http://')) return 'unencrypted-remote';
  if (lower.startsWith('https://')) return 'https-remote';
  if (lower.startsWith('git:') || lower.startsWith('git+')) return 'git';
  if (lower.startsWith('file:') || lower.startsWith('link:')) return 'local-path';
  return 'other';
}

function collectNpmLockfile(text, relativePath) {
  const document = parseJson(text, relativePath);
  const signals = [];
  if (Object.hasOwn(document, 'lockfileVersion')) {
    signals.push({ ruleId: 'SC_LOCKFILE_VERSION', value: document.lockfileVersion });
  }
  const packages = document.packages;
  if (packages === undefined) return signals;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    signals.push({ ruleId: 'SC_LOCK_PACKAGES_NON_OBJECT' });
    return signals;
  }

  for (const locator of Object.keys(packages).sort()) {
    if (locator === '') continue;
    const entry = packages[locator];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      signals.push({ ruleId: 'SC_LOCK_ENTRY_NON_OBJECT', locator: redactReference(locator) });
      continue;
    }
    if (entry.hasInstallScript === true) {
      signals.push({ ruleId: 'SC_LOCK_INSTALL_SCRIPT', locator: redactReference(locator) });
    }
    const resolutionType = classifyResolution(entry.resolved);
    if (resolutionType && resolutionType !== 'https-remote' && resolutionType !== 'other') {
      signals.push({ ruleId: 'SC_LOCK_RESOLUTION_SOURCE', locator: redactReference(locator), sourceType: resolutionType });
    }
    if ((resolutionType === 'https-remote' || resolutionType === 'unencrypted-remote') && typeof entry.integrity !== 'string') {
      signals.push({ ruleId: 'SC_REMOTE_LOCK_ENTRY_WITHOUT_INTEGRITY', locator: redactReference(locator), sourceType: resolutionType });
    }
  }
  return signals;
}

function classifyActionReference(reference) {
  if (reference.includes('${{')) return 'dynamic-expression';
  if (reference.startsWith('./')) return 'local-path';
  if (reference.startsWith('docker://')) return 'container-reference';
  const at = reference.lastIndexOf('@');
  if (at < 1 || at === reference.length - 1) return 'missing-ref';
  const revision = reference.slice(at + 1);
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision) ? 'full-commit' : 'named-ref';
}

function collectWorkflow(text) {
  const signals = [];
  const lines = text.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    let index = lineIndex;
    const match = /^\s*(?:-\s*)?uses\s*:\s*(.+?)\s*$/.exec(line) ?? /[{,]\s*uses\s*:\s*([^,}#]+?)\s*(?:[,}]|$)/.exec(line);
    if (!match) continue;
    let reference = match[1].replace(/\s+#.*$/, '').trim();
    // A folded or literal block scalar (`uses: >-`) carries the reference on the next non-empty line.
    if (/^[|>][-+0-9]*$/.test(reference)) {
      do index += 1; while (index < lines.length && !lines[index].trim());
      reference = (lines[index] ?? '').replace(/\s+#.*$/, '').trim();
    }
    if ((reference.startsWith('"') && reference.endsWith('"')) || (reference.startsWith("'") && reference.endsWith("'"))) {
      reference = reference.slice(1, -1);
    }
    signals.push({
      ruleId: 'SC_WORKFLOW_ACTION_REFERENCE',
      line: index + 1,
      reference: redactReference(reference),
      referenceType: classifyActionReference(reference)
    });
  }
  return signals;
}

function inspectEntry(entry) {
  const relativePath = normalizeRelativePath(entry.path);
  const type = fileType(relativePath);
  const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '', 'utf8');
  if (content.length > MAX_FILE_BYTES) throw new Error(`${relativePath} exceeds ${MAX_FILE_BYTES} bytes`);
  if (type !== 'lockfile' && content.includes(0)) throw new Error(`${relativePath} contains binary data`);

  const text = content.toString('utf8');
  const allSignals = type === 'npm-manifest' ? collectPackageManifest(text, relativePath)
    : type === 'npm-lockfile' ? collectNpmLockfile(text, relativePath)
      : type === 'github-actions-workflow' ? collectWorkflow(text) : [];
  return {
    path: relativePath,
    type,
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    // false: the file type is recognized but its content is not inspected, so no signals is not a clean result.
    analyzed: type === 'npm-manifest' || type === 'npm-lockfile' || type === 'github-actions-workflow',
    signals: allSignals.slice(0, MAX_SIGNALS_PER_FILE),
    truncatedSignals: allSignals.length > MAX_SIGNALS_PER_FILE
  };
}

export function collectSupplyChainSignals(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('at least one evidence file is required');
  if (entries.length > MAX_FILE_COUNT) throw new Error(`file count exceeds ${MAX_FILE_COUNT}`);
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('evidence entries must be objects');
    if (!(typeof entry.content === 'string' || Buffer.isBuffer(entry.content))) throw new Error('evidence content must be text or a Buffer');
    return { ...entry, path: normalizeRelativePath(entry.path) };
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const duplicate = normalized.find((entry, index) => index > 0 && entry.path === normalized[index - 1].path);
  if (duplicate) throw new Error(`duplicate evidence file: ${duplicate.path}`);
  const totalBytes = normalized.reduce((sum, entry) => sum + (Buffer.isBuffer(entry.content) ? entry.content.length : Buffer.byteLength(entry.content ?? '')), 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`total evidence exceeds ${MAX_TOTAL_BYTES} bytes`);
  const files = normalized.map(inspectEntry);
  return {
    schemaVersion: 1,
    collector: 'offline-supply-chain-signals',
    files,
    totals: {
      files: files.length,
      bytes: totalBytes,
      signals: files.reduce((sum, file) => sum + file.signals.length, 0),
      truncatedFiles: files.filter((file) => file.truncatedSignals).length
    }
  };
}

function assertNoSymlinkComponents(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink evidence paths are not allowed: ${relativePath}`);
  }
}

function readEvidence(rootArgument, fileArguments) {
  const root = path.resolve(rootArgument);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('root must be a regular directory, not a symlink');
  const realRoot = realpathSync(root);
  return fileArguments.map((value) => {
    const relativePath = normalizeRelativePath(value);
    assertNoSymlinkComponents(realRoot, relativePath);
    const absolute = path.join(realRoot, ...relativePath.split('/'));
    const realFile = realpathSync(absolute);
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error(`file escapes root: ${relativePath}`);
    const stat = lstatSync(absolute);
    if (!stat.isFile()) throw new Error(`evidence path must be a regular file: ${relativePath}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${relativePath} exceeds ${MAX_FILE_BYTES} bytes`);
    return { path: relativePath, content: readFileSync(absolute) };
  });
}

function parseArguments(argv) {
  let root = null;
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== '--root' && option !== '--file') throw new Error(`unknown option: ${option}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    if (option === '--root') {
      if (root !== null) throw new Error('--root may be supplied only once');
      root = value;
    } else {
      files.push(value);
    }
  }
  if (root === null || files.length === 0) {
    throw new Error('usage: collect-supply-chain-signals.mjs --root <directory> --file <relative-path> [--file <relative-path> ...]');
  }
  return { root, files };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(collectSupplyChainSignals(readEvidence(options.root, options.files)), null, 2)}\n`);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (invokedPath && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`collect-supply-chain-signals: ${error.message}\n`);
    process.exitCode = 1;
  }
}
