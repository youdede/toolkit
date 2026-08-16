#!/usr/bin/env node

import path from 'node:path';

const TEST_EXTENSIONS = new Set([
  '.cjs', '.cs', '.go', '.java', '.js', '.jsx', '.kt', '.kts', '.mjs', '.php', '.py', '.rb', '.rs', '.swift', '.ts', '.tsx'
]);
const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);
export const WRAPPERS = new Set(['exec', 'time', 'noglob', 'command', 'env', 'sudo', 'nohup']);
export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
export const WRAPPER_VALUE_OPTIONS = new Map([
  ['env', new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string'])],
  ['sudo', new Set(['-u', '-g', '-h', '-p', '-r', '-t', '-C', '--user', '--group', '--host', '--prompt', '--role', '--type', '--close-from'])],
  ['time', new Set(['-f', '-o', '--format', '--output'])]
]);

export function executableName(value) {
  return path.posix.basename(String(value || '').replaceAll('\\', '/')).toLowerCase().replace(/\.(?:cmd|exe|bat)$/i, '');
}

export function isAssignment(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value);
}

export function isTestDirectoryPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  return normalized.split('/').some((segment) => TEST_DIRECTORIES.has(segment));
}

export function isExplicitTestDirectory(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  return TEST_DIRECTORIES.has(path.posix.basename(normalized));
}

export function isTestSourcePath(value) {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  const base = path.posix.basename(normalized);
  const extension = path.posix.extname(base);
  if (!TEST_EXTENSIONS.has(extension)) return false;
  return isTestDirectoryPath(normalized)
    || /(?:^|[._-])(?:test|tests|spec|specs)\.[a-z0-9]+$/.test(base)
    || /_test\.go$/.test(base)
    || /_spec\.rb$/.test(base)
    || /^(?:test|spec)[A-Z0-9_.-].*\.(?:java|kt|kts|cs|swift)$/i.test(base);
}
