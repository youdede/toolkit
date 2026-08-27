import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const MAX_SCANNED_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_HISTORY_OBJECTS = 50_000;
const MAX_HISTORY_BATCH_BYTES = 512 * 1024 * 1024;

export const SECRET_RULES = Object.freeze([
  { id: 'PRIVATE_KEY', label: 'private key block', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'AWS_ACCESS_KEY', label: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: 'GITHUB_TOKEN', label: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { id: 'GITHUB_FINE_GRAINED_TOKEN', label: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { id: 'NPM_TOKEN', label: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'ANTHROPIC_KEY', label: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'OPENAI_KEY', label: 'OpenAI API key', pattern: /\bsk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,})\b/ },
  { id: 'SLACK_TOKEN', label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { id: 'STRIPE_LIVE_KEY', label: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { id: 'GITLAB_TOKEN', label: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'GOOGLE_API_KEY', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ }
]);

const SAFE_ENV_SUFFIXES = Object.freeze(['.example', '.sample', '.template', '.dist']);

function normalizeRelative(file) {
  return file.split(path.sep).join('/').replace(/^\.\//, '');
}

export function isSensitivePath(file) {
  const normalized = normalizeRelative(file);
  const base = path.posix.basename(normalized).toLowerCase();
  const envLike = base === '.env' || base.startsWith('.env.');
  if (envLike && !SAFE_ENV_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(base)) return true;
  if (/\.(?:pem|p12|pfx|key|keystore|jks)$/i.test(base)) return true;
  return /^(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|ini))?$/i.test(base);
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

export function scanSecretText(file, content, scope = 'workspace') {
  const findings = [];
  for (const rule of SECRET_RULES) {
    const match = rule.pattern.exec(content);
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

function parseObjectListing(listing) {
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
