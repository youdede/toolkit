import test from 'node:test';
import assert from 'node:assert/strict';

import { commitIntent, commitReadsWorkingTree, commitSkipsHooks, gitCalls, parseGitAliases, readGitAliases } from '../scripts/lib/shared-hook/commit-content.mjs';
import { parseShell } from '../scripts/lib/shared-hook/shell-items.mjs';
import { validIntent } from './capability-contract.mjs';

// Probes of the shared `commit-content` block: the CommitIntent of a command. Aliases are resolved one level; forced adds, alias definitions, shell aliases,
// and aliases of aliases in the same command as a commit are `unsupported`.
const CONFIGURED = new Map([['ci', 'commit'], ['st', 'status'], ['sh', '!git commit -m shell'], ['loop', 'loop']]);
const COMMIT_PROBES = [
  // [command, expected fields]
  ['git commit -m x', { found: true, uninspectable: false, unsupported: null, scopeChanged: false, worktree: false, noVerify: false }],
  ['npm test', { found: false }],
  ['echo "git commit"', { found: false }],
  ['git log --grep commit', { found: false }],
  ['git commit -am x', { worktree: true }],
  ['git commit -m x app.js', { worktree: true }],
  ['git add app.js && git commit -m x', { worktree: true }],
  ['git commit -m a && git add -A && git commit -m b', { worktree: true }],
  // A forced add stages ignored files the working-tree scan does not list.
  ['git add -f .env && git commit -m x', { worktree: true, unsupported: 'force-add' }],
  ['git add --force -- .env secrets/ && git commit -m x', { unsupported: 'force-add' }],
  ['git add -fA && git commit -m x', { unsupported: 'force-add' }],
  ['git add -f .env', { found: false, unsupported: null }],
  ['git add "$FILE" && git commit -m x', { unsupported: null, worktree: true }],
  ['git add .env && git commit -m x', { unsupported: null }],
  ['git commit -nm x', { noVerify: true }],
  ['git commit -mn', { noVerify: false }],
  ['git commit app.js -n', { noVerify: true }],
  ['git commit --no-verify -m x', { noVerify: true }],
  ['git commit --no-ver -m x', { noVerify: true }],
  ['git -c core.hooksPath=/dev/null commit -m x', { noVerify: true }],
  ['git -C ../other commit -m x', { scopeChanged: true }],
  ['cd sub && git commit -m x', { scopeChanged: true }],
  ['env GIT_DIR=$DIR git commit -m x', { found: true, scopeChanged: true }],
  ['GIT_WORK_TREE=/x git commit -m x', { scopeChanged: true }],
  ['echo x | xargs git commit -am', { found: true, worktree: true }],
  ['echo msg | xargs git commit -m', { found: true, worktree: true }],
  ['find . -maxdepth 0 -exec git commit -am x \\;', { found: true, worktree: true }],
  ["bash -lc 'git commit -m ok'", { found: true }],
  ['/usr/bin/git --no-pager commit -m x', { found: true }],
  ['f(){ git commit -am x; }; f', { found: true, worktree: true }],
  // Aliases: configured (one level), defined in the command, or passed with -c.
  ['git ci -am x', { found: true, worktree: true, unsupported: null }],
  ['git config alias.ci commit && git ci -am x', { found: true, unsupported: 'alias-definition' }],
  ['git config --local alias.cm "commit -n" && git cm -m x', { found: true, noVerify: true, unsupported: 'alias-definition' }],
  ['git -c alias.zz=commit zz -m x', { found: true, unsupported: 'alias-definition' }],
  ['git config alias.ship "push --force origin feature:main" && git ship', { found: false }],
  ['git st', { found: false }],
  ['git unknown-tool', { found: false }],
  ['git sh', { found: true, unsupported: 'shell-alias' }],
  ['git loop', { found: true, unsupported: 'alias-chain' }],
  ['git config alias.status commit && git status', { found: false }],
  // Words known only at run time: uninspectable when the command may be a commit.
  ['git config alias.q "$X" && git q', { uninspectable: true }],
  ['git config "$KEY" commit && git q', { uninspectable: true }],
  ['git $SUB -m x', { uninspectable: true }],
  ['git -c "$X" commit -m x', { uninspectable: true }],
  ['g$x commit -m x', { uninspectable: true }],
  ['eval "$X"; git commit -m x', { found: true, uninspectable: true }],
  // A program known only at run time belongs to shell-command-guard.
  ['bash -c "$SCRIPT"', { found: false, uninspectable: false }]
];

test('the commit-content module tells what the commands will commit', () => {
  for (const [command, expected] of COMMIT_PROBES) {
    const actual = commitIntent(parseShell(command), { aliases: CONFIGURED });
    assert.ok(validIntent('CommitIntent', actual), command);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `${command}: ${key}`);
  }
  let reads = 0;
  commitIntent(parseShell('git status && git commit -m x && npm test'), { aliases: () => { reads += 1; return new Map(); } });
  assert.equal(reads, 0, 'built-in subcommands never read aliases');
  commitIntent(parseShell('git st && git st'), { aliases: () => { reads += 1; return CONFIGURED; } });
  assert.equal(reads, 1, 'aliases are read once per command');
  const calls = gitCalls(parseShell('git ci -am x && git sh'), { aliases: CONFIGURED }).calls;
  assert.deepEqual(calls.map((call) => [call.name, call.alias]), [['commit', null], [null, 'shell']]);
});

test('commit option parsing follows git commit syntax', () => {
  const words = (text) => text.split(' ').map((value) => ({ kind: 'static', text: value }));
  for (const args of ['-am x', '-a -m x', '--all -m x', '-m x app.js', '-m x -- app.js', '--only -m x', '--include -m x', '-p', '--interactive', '--pathspec-from-file=list.txt']) {
    assert.equal(commitReadsWorkingTree(words(args)), true, args);
  }
  for (const args of ['-m x', '-F msg.txt', '--amend --no-edit', '-S -m x', '-Sdeadbeef -m x', '-C HEAD', '--author=me -m x', '-s -m x', '-uno -m x']) {
    assert.equal(commitReadsWorkingTree(words(args)), false, args);
  }
  for (const args of ['-n', '-nm x', '-anm x', 'file -n', '--no-verify', '--no-v']) assert.equal(commitSkipsHooks(words(args)), true, args);
  for (const args of ['-m -n', '-mn', '-m x', '--no-edit', '-F -n', '-- -n']) assert.equal(commitSkipsHooks(words(args)), false, args);
  // A word known only at run time is a pathspec, never an option.
  assert.equal(commitReadsWorkingTree([{ kind: 'static', text: '-m' }, { kind: 'pattern', text: '$M', parts: [{ any: 'expansion' }] }]), true);
});

test('Git aliases are read with git config --get-regexp and fail closed', () => {
  assert.deepEqual([...parseGitAliases('alias.ci\ncommit\0alias.LG\nlog --graph\nx\0alias.empty\0')], [['ci', 'commit'], ['lg', 'log --graph\nx'], ['empty', '']]);
  const calls = [];
  const aliases = readGitAliases((args) => { calls.push(args); return { status: 0, stdout: 'alias.ci\ncommit\0' }; });
  assert.deepEqual(calls, [['config', '-z', '--get-regexp', '^alias\\.']]);
  assert.equal(aliases.get('ci'), 'commit');
  assert.equal(readGitAliases(() => ({ status: 1, stdout: '' })).size, 0);
  assert.throws(() => readGitAliases(() => ({ status: 128, stdout: '', stderr: 'fatal: bad config' })), /bad config/);
  assert.throws(() => readGitAliases(() => ({ error: new Error('spawn git ENOENT') })), /ENOENT/);
});

test('commit intent ends quickly on alias loops and long commands', () => {
  const loops = new Map([...Array.from({ length: 50 }, (_, index) => [`a${index}`, `a${index + 1}`]), ['a50', 'a0'], ['self', 'self']]);
  for (const command of ['git a0', 'git self', `git ${'-c a=b '.repeat(30000)}commit`, `git commit ${'-n'.repeat(100000)}`, 'git add x && '.repeat(15000)]) {
    const started = performance.now();
    commitIntent(parseShell(command), { aliases: loops });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `${JSON.stringify(command.slice(0, 40))} took ${Math.round(elapsed)} ms`);
  }
  assert.equal(commitIntent(parseShell('git a0'), { aliases: loops }).unsupported, 'alias-chain');
});
