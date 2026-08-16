#!/usr/bin/env node

import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024;

const RULE_PRIORITY = new Map([
  ['ci-untrusted-trigger-secret-exposure', 0],
  ['ci-untrusted-trigger-write-authority', 1],
  ['ci-permissions-write-all', 2],
  ['ci-permission-expanded', 3],
  ['ci-broad-secret-inheritance', 4],
  ['ci-persisted-checkout-credentials', 5],
  ['ci-secret-trace-enabled', 6],
  ['ci-privileged-executor', 7],
  ['ci-host-runtime-socket', 8]
  ,['ci-permission-alias-uninspectable', 9]
]);
const SECRET_EXPRESSION = /\$\{\{\s*secrets\s*(?:\.|\[['"])[^}\]]+/i;

function normalizeRelative(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

export function classifyCiPath(value) {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(normalized)) return 'github-actions';
  if (/^\.gitlab-ci\.ya?ml$/.test(normalized) || /^\.gitlab-ci\/[^/]+\.ya?ml$/.test(normalized)) return 'gitlab-ci';
  if (/^\.circleci\/config\.ya?ml$/.test(normalized)) return 'circleci';
  if (/^\.buildkite\/(?:pipeline|[^/]+)\.ya?ml$/.test(normalized) || /^buildkite\.ya?ml$/.test(normalized)) return 'buildkite';
  if (/^azure-pipelines\.ya?ml$/.test(normalized) || /^\.azure-pipelines\/[^/]+\.ya?ml$/.test(normalized)) return 'azure-pipelines';
  return null;
}

function readBoundedRegularFile(target) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error('symlink targets are not inspected');
  if (!stat.isFile()) throw new Error('target is not a regular file');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`existing CI file exceeds ${MAX_FILE_BYTES} bytes`);
  const descriptor = openSync(target, 'r');
  try {
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== buffer.length) throw new Error('existing CI file changed during inspection');
    return buffer.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function countOccurrences(content, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function reconstructEdit(existing, toolInput) {
  const oldString = toolInput?.old_string;
  const newString = toolInput?.new_string;
  if (typeof oldString !== 'string' || oldString.length === 0 || typeof newString !== 'string') {
    throw new Error('Edit requires non-empty old_string and string new_string');
  }
  const occurrences = countOccurrences(existing, oldString);
  if (toolInput?.replace_all === true) {
    if (occurrences === 0) throw new Error('old_string was not found');
    return existing.split(oldString).join(newString);
  }
  if (occurrences !== 1) throw new Error(`old_string matched ${occurrences} times`);
  return existing.replace(oldString, newString);
}

function stripYamlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return line.slice(0, index);
  }
  return line;
}

function scalarValue(value) {
  const trimmed = value.trim().replace(/[\s,]+$/, '');
  if (trimmed.length >= 2 && ((trimmed[0] === '"' && trimmed.at(-1) === '"') || (trimmed[0] === "'" && trimmed.at(-1) === "'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function yamlKeyValue(line) {
  const match = /^(\s*)(?:-\s*)?(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:\s*(.*?)\s*$/.exec(line);
  if (!match) return null;
  return { indent: match[1].replaceAll('\t', '  ').length, key: (match[2] || match[3] || match[4]).toLowerCase(), value: scalarValue(match[5]) };
}

function finding(ruleId, line, provider, detail = '') {
  return { ruleId, line, provider, detail };
}

export function scanCiTrust(content, provider) {
  if (typeof content !== 'string') throw new Error('CI content must be text');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`proposed CI file exceeds ${MAX_FILE_BYTES} bytes`);

  const findings = [];
  const lines = content.split(/\r?\n/);
  let permissionsIndent = null;
  let blockScalarIndent = null;
  let hasUntrustedTrigger = false;
  let untrustedTriggerLine = null;
  let hasContributorCheckout = false;
  let hasSecretReference = false;
  let hasWriteAuthority = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const withoutComment = stripYamlComment(lines[index]);
    const indent = (withoutComment.match(/^\s*/) || [''])[0].replaceAll('\t', '  ').length;
    const isBlank = withoutComment.trim() === '';

    if (blockScalarIndent !== null) {
      if (isBlank || indent > blockScalarIndent) {
        if (SECRET_EXPRESSION.test(withoutComment)) hasSecretReference = true;
        continue;
      }
      blockScalarIndent = null;
    }

    if (permissionsIndent !== null && !isBlank && indent <= permissionsIndent) permissionsIndent = null;

    const keyValue = yamlKeyValue(withoutComment);
    if (keyValue && /^[|>][+-]?[0-9]?$/.test(keyValue.value)) blockScalarIndent = keyValue.indent;

    if (SECRET_EXPRESSION.test(withoutComment)) hasSecretReference = true;

    if (provider === 'github-actions' && keyValue) {
      if (keyValue.key === 'permissions') {
        if (keyValue.value.toLowerCase() === 'write-all') {
          findings.push(finding('ci-permissions-write-all', lineNumber, provider));
          hasWriteAuthority = true;
        }
        const inlineAuthority = /(?:^|[{,]\s*)["']?(?:actions|checks|contents|deployments|id-token|packages|pull-requests|security-events)["']?\s*:\s*["']?write["']?(?:\s*[,}]|$)/i.test(keyValue.value);
        if (inlineAuthority) {
          findings.push(finding('ci-permission-expanded', lineNumber, provider, 'inline-map'));
          hasWriteAuthority = true;
        }
        if (keyValue.value === '' || keyValue.value === '{' || /^&[A-Za-z0-9_.-]+$/.test(keyValue.value)) permissionsIndent = keyValue.indent;
        if (/^\*[A-Za-z0-9_.-]+$/.test(keyValue.value)) {
          findings.push(finding('ci-permission-alias-uninspectable', lineNumber, provider, keyValue.value));
          hasWriteAuthority = true;
        }
      } else if (permissionsIndent !== null && keyValue.indent > permissionsIndent && keyValue.value.toLowerCase() === 'write') {
        const highAuthority = new Set(['actions', 'checks', 'contents', 'deployments', 'id-token', 'packages', 'pull-requests', 'security-events']);
        if (highAuthority.has(keyValue.key)) {
          findings.push(finding('ci-permission-expanded', lineNumber, provider, keyValue.key));
          hasWriteAuthority = true;
        }
      }
      if (['pull_request_target', 'workflow_run'].includes(keyValue.key)
        || (keyValue.key === 'on' && /(?:^|[\s[,] ?)(?:pull_request_target|workflow_run)(?:[\s,\]]|$)/.test(keyValue.value))) {
        hasUntrustedTrigger = true;
        untrustedTriggerLine ??= lineNumber;
      }
      if (keyValue.key === 'secrets' && keyValue.value.toLowerCase() === 'inherit') {
        findings.push(finding('ci-broad-secret-inheritance', lineNumber, provider));
        hasSecretReference = true;
      }
      if (keyValue.key === 'ref' && /\$\{\{\s*(?:github\.head_ref|github\.event\.(?:pull_request\.(?:head\.(?:sha|ref)|head_ref)|workflow_run\.head_(?:sha|branch)))\s*\}\}/i.test(keyValue.value)) {
        hasContributorCheckout = true;
      }
    }

    if (provider === 'azure-pipelines' && keyValue?.key === 'persistcredentials' && keyValue.value.toLowerCase() === 'true') {
      findings.push(finding('ci-persisted-checkout-credentials', lineNumber, provider));
    }
    if (provider === 'gitlab-ci' && keyValue?.key === 'ci_debug_trace' && keyValue.value.toLowerCase() === 'true') {
      findings.push(finding('ci-secret-trace-enabled', lineNumber, provider));
    }
    if (keyValue?.key === 'privileged' && keyValue.value.toLowerCase() === 'true') {
      findings.push(finding('ci-privileged-executor', lineNumber, provider));
    }
    if (/\bprivileged\s*:\s*(?:true|["']true["'])\b/i.test(withoutComment) && keyValue?.key !== 'privileged') {
      findings.push(finding('ci-privileged-executor', lineNumber, provider));
    }
    if (/\/var\/run\/(?:docker|podman)\.sock\b/i.test(withoutComment)) {
      findings.push(finding('ci-host-runtime-socket', lineNumber, provider));
    }
  }

  if (provider === 'github-actions' && hasUntrustedTrigger && hasContributorCheckout && hasSecretReference) {
    findings.push(finding('ci-untrusted-trigger-secret-exposure', untrustedTriggerLine || 1, provider));
  }
  if (provider === 'github-actions' && hasUntrustedTrigger && hasContributorCheckout && hasWriteAuthority) {
    findings.push(finding('ci-untrusted-trigger-write-authority', untrustedTriggerLine || 1, provider));
  }

  return findings.sort((left, right) => {
    const priority = (RULE_PRIORITY.get(left.ruleId) ?? 99) - (RULE_PRIORITY.get(right.ruleId) ?? 99);
    return priority || left.line - right.line || left.ruleId.localeCompare(right.ruleId);
  });
}

function newFindings(before, after) {
  const available = new Map();
  const key = (item) => `${item.ruleId}:${item.detail || ''}`;
  for (const item of before) available.set(key(item), (available.get(key(item)) || 0) + 1);
  const added = [];
  for (const item of after) {
    const count = available.get(key(item)) || 0;
    if (count > 0) available.set(key(item), count - 1);
    else added.push(item);
  }
  return added;
}

export function collectContext(input, cwd = process.cwd()) {
  const toolInput = input?.tool_input || input?.toolInput || {};
  const rawPath = toolInput.file_path || toolInput.file;
  if (typeof rawPath !== 'string') return { relevant: false };

  const projectRoot = path.resolve(process.env.CLAUDE_PROJECT_DIR || input?.cwd || cwd);
  const target = path.resolve(projectRoot, rawPath);
  const relative = normalizeRelative(path.relative(projectRoot, target));
  const rawProvider = classifyCiPath(rawPath.replace(/^(?:\.\.\/[\\/]?)+/, ''));
  const contained = relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
  if (!contained) {
    return rawProvider
      ? { relevant: true, errorRule: 'ci-file-inspection-failed', inspectionError: 'CI path leaves the active project root' }
      : { relevant: false };
  }

  const provider = classifyCiPath(relative);
  if (!provider) return { relevant: false };

  try {
    const canonicalRoot = realpathSync(projectRoot);
    let existing = projectRoot;
    for (const segment of path.relative(projectRoot, target).split(path.sep).filter(Boolean)) {
      const candidate = path.join(existing, segment);
      try {
        if (lstatSync(candidate).isSymbolicLink()) throw new Error('CI path traverses a symbolic link');
        existing = candidate;
      } catch (error) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
    }
    const canonicalExisting = realpathSync(existing);
    const canonicalRelative = path.relative(canonicalRoot, canonicalExisting);
    if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
      throw new Error('CI path resolves outside the active project root');
    }
  } catch (error) {
    return { relevant: true, provider, relative, errorRule: 'ci-file-inspection-failed', inspectionError: error.message };
  }

  let existing = '';
  let exists = false;
  try {
    existing = readBoundedRegularFile(target);
    exists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { relevant: true, provider, relative, errorRule: 'ci-file-inspection-failed', inspectionError: error.message };
    }
  }

  let proposed;
  try {
    if (typeof toolInput.content === 'string') proposed = toolInput.content;
    else {
      if (!exists) throw new Error('Edit target does not exist');
      proposed = reconstructEdit(existing, toolInput);
    }
    if (Buffer.byteLength(proposed, 'utf8') > MAX_FILE_BYTES) {
      return { relevant: true, provider, relative, errorRule: 'ci-input-too-large', inspectionError: `proposed CI file exceeds ${MAX_FILE_BYTES} bytes` };
    }
    return {
      relevant: true,
      provider,
      relative,
      beforeFindings: scanCiTrust(existing, provider),
      afterFindings: scanCiTrust(proposed, provider)
    };
  } catch (error) {
    return { relevant: true, provider, relative, errorRule: 'ci-edit-inspection-incomplete', inspectionError: error.message };
  }
}

export function evaluate(_input, context = {}) {
  if (!context.relevant) return { exitCode: 0, message: '', ruleId: null };
  if (context.inspectionError) {
    const ruleId = context.errorRule || 'ci-file-inspection-failed';
    return {
      exitCode: 2,
      ruleId,
      message: `BLOCKED by ci-trust-boundary-guard [${ruleId}]: the proposed CI trust boundary could not be verified safely.`
    };
  }
  const added = newFindings(context.beforeFindings || [], context.afterFindings || []);
  if (added.length === 0) return { exitCode: 0, message: '', ruleId: null };
  const first = added[0];
  const location = context.relative ? `${context.relative}:${first.line}` : `line ${first.line}`;
  return {
    exitCode: 2,
    ruleId: first.ruleId,
    message: `BLOCKED by ci-trust-boundary-guard [${first.ruleId}]: ${location} introduces a high-confidence CI trust-boundary expansion. A person must review the exact policy change outside the guarded agent session.`
  };
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error(`hook input exceeds ${MAX_STDIN_BYTES} bytes`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error(`hook input is not valid JSON: ${error.message}`);
  }
}

async function main() {
  let result;
  try {
    const input = await readInput();
    result = evaluate(input, collectContext(input));
  } catch (error) {
    result = { exitCode: 2, ruleId: 'ci-input-invalid', message: `BLOCKED by ci-trust-boundary-guard [ci-input-invalid]: ${error.message}.` };
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
