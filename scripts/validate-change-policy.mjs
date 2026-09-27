#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;
export const MAX_COMMIT_HEADER_CHARACTERS = 72;
export const MAX_COMMIT_BODY_LINE_CHARACTERS = 100;
export const MAX_BRANCH_CHARACTERS = 100;

const TYPES = ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert', 'security'];
const BRANCH_PREFIXES = ['feat', 'fix', 'docs', 'refactor', 'test', 'ci', 'chore', 'security', 'release', 'codex', 'agent', 'dependabot', 'renovate'];
const HEADER = new RegExp(`^(${TYPES.join('|')})(?:\\(([a-z0-9][a-z0-9._/-]*)\\))?(!)?: ([a-z0-9][^\\r\\n]*)$`);

function violation(rule, message) {
  return { rule, message };
}

export function evaluateCommitMessage(input) {
  const violations = [];
  if (typeof input !== 'string') {
    return { valid: false, violations: [violation('COMMIT_MESSAGE_TYPE', 'commit message must be text')] };
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) {
    return { valid: false, violations: [violation('COMMIT_MESSAGE_SIZE', `commit message exceeds ${MAX_COMMIT_MESSAGE_BYTES} bytes`)] };
  }

  const message = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/u, '');
  if (message.length === 0) {
    return { valid: false, violations: [violation('COMMIT_MESSAGE_EMPTY', 'commit message is empty')] };
  }

  const lines = message.split('\n');
  const header = lines[0];
  // A squash merge on GitHub appends " (#123)" to the reviewed header; the limit applies to the header itself.
  if (header.replace(/ \(#\d+\)$/u, '').length > MAX_COMMIT_HEADER_CHARACTERS) {
    violations.push(violation('COMMIT_HEADER_LENGTH', `commit header exceeds ${MAX_COMMIT_HEADER_CHARACTERS} characters`));
  }
  if (/^(?:fixup!|squash!|WIP(?:\b|:))/u.test(header)) {
    violations.push(violation('COMMIT_TEMPORARY_PREFIX', 'temporary commit prefixes are not allowed'));
  }

  const match = HEADER.exec(header);
  if (!match) {
    violations.push(violation('COMMIT_HEADER_FORMAT', 'commit header must follow type(optional-scope)!: lowercase summary'));
  } else {
    const [, , , breaking, summary] = match;
    if (summary.endsWith('.')) violations.push(violation('COMMIT_SUMMARY_PERIOD', 'commit summary must not end with a period'));
    if (/\s{2,}/u.test(summary)) violations.push(violation('COMMIT_SUMMARY_SPACING', 'commit summary contains repeated whitespace'));
    if (breaking && !lines.some((line) => line.startsWith('BREAKING CHANGE: '))) {
      violations.push(violation('COMMIT_BREAKING_FOOTER', 'a breaking header requires a BREAKING CHANGE footer'));
    }
  }

  if (lines.length > 1 && lines[1] !== '') {
    violations.push(violation('COMMIT_BODY_SEPARATOR', 'commit body must be separated from the header by a blank line'));
  }
  if (lines.slice(1).some((line) => line.length > MAX_COMMIT_BODY_LINE_CHARACTERS)) {
    violations.push(violation('COMMIT_BODY_LINE_LENGTH', `commit body lines must not exceed ${MAX_COMMIT_BODY_LINE_CHARACTERS} characters`));
  }

  return { valid: violations.length === 0, violations };
}

export function evaluateBranchName(input) {
  const violations = [];
  if (typeof input !== 'string' || input.length === 0) {
    return { valid: false, violations: [violation('BRANCH_NAME_EMPTY', 'branch name is empty')] };
  }
  if (input === 'main') return { valid: true, violations: [] };
  if (input.length > MAX_BRANCH_CHARACTERS) {
    violations.push(violation('BRANCH_NAME_LENGTH', `branch name exceeds ${MAX_BRANCH_CHARACTERS} characters`));
  }
  const slash = input.indexOf('/');
  const prefix = slash === -1 ? '' : input.slice(0, slash);
  const description = slash === -1 ? '' : input.slice(slash + 1);
  if (!BRANCH_PREFIXES.includes(prefix)) {
    violations.push(violation('BRANCH_PREFIX', `branch prefix must be one of ${BRANCH_PREFIXES.join(', ')}`));
  }
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(description)) {
    violations.push(violation('BRANCH_DESCRIPTION', 'branch description must be lowercase and separated by hyphens, dots, underscores, or slashes'));
  }
  return { valid: violations.length === 0, violations };
}

function readCommitMessage(file) {
  const metadata = lstatSync(file);
  if (metadata.isSymbolicLink()) throw new Error('commit message path must not be a symbolic link');
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error('commit message path must be a regular file');
  if (stat.size > MAX_COMMIT_MESSAGE_BYTES) throw new Error(`commit message exceeds ${MAX_COMMIT_MESSAGE_BYTES} bytes`);
  return readFileSync(file, 'utf8');
}

function subjectsForRange(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 200 || !/^[0-9A-Za-z._~^/:+.-]+$/u.test(input)) {
    throw new Error('Git range is malformed');
  }
  const allZeroBase = /^(?:0{40}|0{64})\.\./u.test(input);
  const range = allZeroBase ? input.slice(input.indexOf('..') + 2) : input;
  const output = execFileSync('git', ['log', '--format=%H%x00%s%x00', range], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const fields = output.split('\0');
  const commits = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const hash = fields[index].trim();
    const subject = fields[index + 1];
    if (hash) commits.push({ hash, subject });
  }
  if (commits.length === 0) throw new Error('Git range contains no commits');
  return commits;
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  if (index === process.argv.length - 1) throw new Error(`${flag} requires a value`);
  return process.argv[index + 1];
}

function report(label, result) {
  if (result.valid) return;
  for (const item of result.violations) {
    console.error(`CHANGE_POLICY_FAIL ${label} ${item.rule}: ${item.message}`);
  }
  process.exitCode = 1;
}

function runCli() {
  const file = argumentValue('--file');
  const message = argumentValue('--message');
  const range = argumentValue('--range');
  const branch = argumentValue('--branch');
  const label = argumentValue('--label') || 'change';
  const modes = [file, message, range, branch].filter((value) => value !== undefined);
  if (modes.length !== 1) throw new Error('choose exactly one of --file, --message, --range, or --branch');

  if (file !== undefined) {
    report(label, evaluateCommitMessage(readCommitMessage(file)));
    return;
  }
  if (message !== undefined) {
    report(label, evaluateCommitMessage(message));
    return;
  }
  if (branch !== undefined) {
    report(label, evaluateBranchName(branch));
    return;
  }

  const commits = subjectsForRange(range);
  for (const commit of commits) report(`${label}:${commit.hash.slice(0, 12)}`, evaluateCommitMessage(commit.subject));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runCli();
  } catch (error) {
    console.error(`CHANGE_POLICY_ERROR: ${error.message}`);
    process.exitCode = 2;
  }
}
