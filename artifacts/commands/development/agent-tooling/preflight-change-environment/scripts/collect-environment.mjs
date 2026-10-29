#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const cwd = process.cwd();
const git = (...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))) });
const revision = git('rev-parse', '--short=12', 'HEAD');
const branch = git('symbolic-ref', '--short', '-q', 'HEAD');
const status = git('status', '--porcelain');
const markers = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'pyproject.toml', 'Cargo.toml', 'go.mod'].filter((name) => existsSync(path.join(cwd, name)));
const result = { schemaVersion: 1, runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, repository: { isGitWorktree: revision.status === 0, revision: revision.status === 0 ? revision.stdout.trim() : null, branch: branch.status === 0 ? branch.stdout.trim() : 'detached-or-unavailable', dirtyEntryCount: status.status === 0 ? status.stdout.split('\n').filter(Boolean).length : null }, markers };
process.stdout.write(JSON.stringify(result) + '\n');
