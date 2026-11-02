import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SECRET_RULES as HOOK_SECRET_RULES, secretMatch } from './shared-hook/secret-rules.mjs';
import { isCommitSecretPath } from './shared-hook/sensitive-paths.mjs';

export const MAX_SCANNED_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_HISTORY_OBJECTS = 50_000;
const MAX_HISTORY_BATCH_BYTES = 512 * 1024 * 1024;

// The hooks' list, with the repository scan's upper-case rule ids (GITHUB_TOKEN).
export const SECRET_RULES = Object.freeze(HOOK_SECRET_RULES.map((rule) => ({ ...rule, id: rule.id.toUpperCase().replaceAll('-', '_') })));

function normalizeRelative(file) {
  return file.split(path.sep).join('/').replace(/^\.\//, '');
}

// The commit tier of the shared sensitive-paths block, the one commit-guard applies.
export const isSensitivePath = isCommitSecretPath;

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

export function scanSecretText(file, content, scope = 'workspace') {
  const findings = [];
  for (const rule of SECRET_RULES) {
    const match = secretMatch(rule, content);
    if (match) {
      findings.push({
        ruleId: rule.id,
        label: rule.label,
        path: normalizeRelative(file),
        line: lineNumberAt(content, match.index),
        scope
      });
    }
  }
  return findings;
}

function cleanGitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^GIT_/i.test(name)));
}

function git(args, cwd, encoding = 'utf8', maxBuffer = 32 * 1024 * 1024) {
  const result = spawnSync('git', args, {
    cwd,
    encoding,
    env: cleanGitEnvironment(),
    maxBuffer,
    shell: false,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'unknown git error').trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

export function collectTrackedPaths(root) {
  return String(git(['ls-files', '--cached', '-z'], root))
    .split('\0')
    .filter(Boolean)
    .map(normalizeRelative)
    .sort((left, right) => left.localeCompare(right));
}

function finding(ruleId, label, file, scope) {
  return { ruleId, label, path: normalizeRelative(file), line: 1, scope };
}

export function scanWorkspacePaths(root, records) {
  const rootPath = path.resolve(root);
  const normalized = [...records]
    .map((record) => ({
      path: normalizeRelative(record.path),
      scopes: [...new Set(record.scopes ?? [record.scope ?? 'workspace'])].sort()
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const findings = [];
  let textFiles = 0;
  let binaryFiles = 0;

  for (const record of normalized) {
    const absolute = path.resolve(rootPath, record.path);
    const relative = path.relative(rootPath, absolute);
    const scope = record.scopes.join('+');
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      findings.push(finding('PATH_OUTSIDE_ROOT', 'path resolves outside repository root', record.path, scope));
      continue;
    }

    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT' && !record.scopes.includes('package')) continue;
      findings.push(finding('FILE_UNREADABLE', 'file could not be inspected', record.path, scope));
      continue;
    }
    if (stat.isSymbolicLink()) {
      findings.push(finding('SYMLINK_UNSCANNED', 'symbolic link is not accepted as release input', record.path, scope));
      continue;
    }
    if (!stat.isFile()) continue;
    if (isSensitivePath(record.path)) {
      findings.push(finding('SENSITIVE_PATH', 'sensitive file type', record.path, scope));
    }
    if (stat.size > MAX_SCANNED_FILE_BYTES) {
      findings.push(finding('FILE_TOO_LARGE', `file exceeds ${MAX_SCANNED_FILE_BYTES} byte scan limit`, record.path, scope));
      continue;
    }

    let content;
    try {
      content = readFileSync(absolute);
    } catch {
      findings.push(finding('FILE_UNREADABLE', 'file could not be inspected', record.path, scope));
      continue;
    }
    if (content.includes(0)) {
      binaryFiles += 1;
      continue;
    }
    textFiles += 1;
    findings.push(...scanSecretText(record.path, content.toString('utf8'), scope));
  }

  return { files: normalized.length, textFiles, binaryFiles, findings: sortFindings(findings) };
}

// `rev-list --objects -z` emits NUL-delimited records carrying a `path=` prefix only from Git
// 2.47 on. Earlier versions accept `-z` and ignore it, printing `<object-id>[ <path>]` lines
// instead (verified on git 2.43.0, which Debian 12 and Ubuntu 24.04 LTS still ship), so the
// listing is read by the shape Git actually produced rather than the shape it was asked for.
// Both readers refuse what they do not recognise: an object a history scan cannot account for
// must stop the scan, never be skipped quietly.
export function parseObjectListing(listing) {
  return listing.includes('\0') ? parseDelimitedObjectListing(listing) : parseLineObjectListing(listing);
}

function parseDelimitedObjectListing(listing) {
  const objects = new Map();
  let previousObjectId = null;
  for (const entry of listing.split('\0')) {
    if (!entry) continue;
    if (entry.startsWith('path=')) {
      if (!previousObjectId) throw new Error('git rev-list returned a path without an object');
      objects.get(previousObjectId).add(normalizeRelative(entry.slice('path='.length)));
      continue;
    }
    if (!/^[0-9a-f]{40,64}$/.test(entry)) throw new Error('git rev-list returned malformed object metadata');
    previousObjectId = entry;
    if (!objects.has(entry)) objects.set(entry, new Set());
  }
  return objects;
}

// The pre-2.47 shape. A path holding a newline splits into a continuation line that matches no
// object id, which fails the scan closed instead of mapping a blob to the wrong path. Root trees
// are printed with a trailing space and no path, so an empty path is never recorded.
function parseLineObjectListing(listing) {
  const objects = new Map();
  for (const line of listing.split('\n')) {
    if (!line) continue;
    const separator = line.indexOf(' ');
    const objectId = separator === -1 ? line : line.slice(0, separator);
    if (!/^[0-9a-f]{40,64}$/.test(objectId)) throw new Error('git rev-list returned malformed object metadata');
    if (!objects.has(objectId)) objects.set(objectId, new Set());
    const objectPath = separator === -1 ? '' : line.slice(separator + 1);
    if (objectPath) objects.get(objectId).add(normalizeRelative(objectPath));
  }
  return objects;
}

function parseBatchHeader(buffer, offset) {
  const end = buffer.indexOf(10, offset);
  if (end < 0) throw new Error('git cat-file returned a truncated batch header');
  const header = buffer.subarray(offset, end).toString('utf8');
  const [objectId, type, rawSize] = header.split(' ');
  if (!objectId || !type || rawSize === undefined) throw new Error('git cat-file returned malformed batch metadata');
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('git cat-file returned an invalid object size');
  return { objectId, type, size, contentStart: end + 1 };
}

export function scanGitHistory(root) {
  const listing = String(git(['rev-list', '--objects', '--all', '-z'], root));
  const objects = parseObjectListing(listing);
  if (objects.size > MAX_HISTORY_OBJECTS) {
    return {
      files: 0,
      textFiles: 0,
      binaryFiles: 0,
      findings: [finding('HISTORY_OBJECT_LIMIT', `history exceeds ${MAX_HISTORY_OBJECTS} object scan limit`, '.git', 'history')]
    };
  }

  const objectIds = [...objects.keys()];
  if (objectIds.length === 0) return { files: 0, textFiles: 0, binaryFiles: 0, findings: [] };
  const input = `${objectIds.join('\n')}\n`;
  const outcome = spawnSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input,
    encoding: null,
    env: cleanGitEnvironment(),
    maxBuffer: MAX_HISTORY_BATCH_BYTES,
    shell: false,
    windowsHide: true
  });
  if (outcome.error || outcome.status !== 0) {
    const detail = String(outcome.stderr || outcome.error?.message || 'unknown git error').trim();
    throw new Error(`git cat-file failed${detail ? `: ${detail}` : ''}`);
  }

  const buffer = outcome.stdout;
  const findings = [];
  let offset = 0;
  let files = 0;
  let textFiles = 0;
  let binaryFiles = 0;
  for (let index = 0; index < objectIds.length; index += 1) {
    const header = parseBatchHeader(buffer, offset);
    const contentEnd = header.contentStart + header.size;
    if (contentEnd >= buffer.length || buffer[contentEnd] !== 10) {
      throw new Error('git cat-file returned truncated object content');
    }
    offset = contentEnd + 1;
    if (header.type !== 'blob') continue;

    files += 1;
    const paths = [...(objects.get(header.objectId) ?? [])].sort((left, right) => left.localeCompare(right));
    const representative = paths[0] ?? `.git/objects/${header.objectId}`;
    for (const objectPath of paths) {
      if (isSensitivePath(objectPath)) findings.push(finding('SENSITIVE_PATH', 'sensitive file type', objectPath, 'history'));
    }
    if (header.size > MAX_SCANNED_FILE_BYTES) {
      findings.push(finding('FILE_TOO_LARGE', `historical blob exceeds ${MAX_SCANNED_FILE_BYTES} byte scan limit`, representative, 'history'));
      continue;
    }
    const content = buffer.subarray(header.contentStart, contentEnd);
    if (content.includes(0)) {
      binaryFiles += 1;
      continue;
    }
    textFiles += 1;
    findings.push(...scanSecretText(representative, content.toString('utf8'), 'history'));
  }

  return { files, textFiles, binaryFiles, findings: sortFindings(findings) };
}

export function sortFindings(findings) {
  return [...findings].sort((left, right) => left.path.localeCompare(right.path)
    || left.line - right.line
    || left.ruleId.localeCompare(right.ruleId)
    || left.scope.localeCompare(right.scope));
}
