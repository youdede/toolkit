#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BUFFER = 1024 * 1024;
const MAX_COMMITS = 50;
const MAX_FILES = 200;
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: MAX_BUFFER });
  if (result.error || result.status !== 0) throw new Error(String(result.stderr || result.error?.message || 'git failed').trim());
  return result.stdout.trimEnd();
}
function verifiedRevision(cwd, revision) { return git(cwd, ['rev-parse', '--verify', `${revision}^{commit}`]); }
export function collectReleaseEvidence({ cwd, from, to }) {
  if (!cwd || !from || !to) throw new Error('cwd, from, and to are required');
  const root = git(path.resolve(cwd), ['rev-parse', '--show-toplevel']);
  const start = verifiedRevision(root, from);
  const end = verifiedRevision(root, to);
  const range = `${start}..${end}`;
  const commits = git(root, ['log', `--max-count=${MAX_COMMITS + 1}`, '--format=%H%x09%s', range]).split('\n').filter(Boolean);
  const files = git(root, ['diff', '--name-status', range]).split('\n').filter(Boolean);
  return { schemaVersion: 1, root, from: start, to: end, commits: commits.slice(0, MAX_COMMITS), commitsTruncated: commits.length > MAX_COMMITS, changedFiles: files.slice(0, MAX_FILES), changedFilesTruncated: files.length > MAX_FILES, diffStat: git(root, ['diff', '--stat', range]) };
}
function main(argv) {
  if (argv.length !== 6 || argv[0] !== '--cwd' || argv[2] !== '--from' || argv[4] !== '--to') throw new Error('usage: collect-release-evidence.mjs --cwd <repository> --from <revision> --to <revision>');
  process.stdout.write(`${JSON.stringify(collectReleaseEvidence({ cwd: argv[1], from: argv[3], to: argv[5] }), null, 2)}\n`);
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) { try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`collect-release-evidence: ${error.message}\n`); process.exitCode = 1; } }
