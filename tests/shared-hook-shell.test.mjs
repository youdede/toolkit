import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SHELL_MAX_COMMAND_BYTES, gitInvocation, parseShellCommands } from '../scripts/lib/shared-hook/shell.mjs';
import { analyzeCommitContent, commitReadsWorkingTree, commitSkipsHooks, parseGitAliases, readGitAliases } from '../scripts/lib/shared-hook/commit-content.mjs';
import { generateSharedHooks, loadSharedModules, renderSharedBlocks } from '../scripts/generate-shared-hooks.mjs';

// One probe suite for the shared hook modules. Every hook that embeds the `shell` block inherits
// these probes: the process probes at the end run against each such payload, so a hook migrated in
// a later lot is covered without new test code.

// A command renders as `wrappers|tokens [operator]` per normalized command; `<P>` is a value xargs
// or find supplies at run time, `$…` a dynamic token, and AMBIGUOUS an entry that fails closed.
function render(command) {
  const parsed = parseShellCommands(command);
  if (parsed.error) return `ERROR ${parsed.error}`;
  return parsed.commands.map((entry) => {
    if (entry.ambiguous) return 'AMBIGUOUS';
    const tokens = entry.tokens.map((token) => (token.placeholder ? '<P>' : token.dynamic ? `$${token.value}` : token.value)).join(' ');
    return `${entry.wrappers.join('+')}|${tokens} [${entry.operator}]${entry.changedDirectory ? ' cd' : ''}`;
  });
}

const SHELL_PROBES = [
  // Segments and the operator that follows each one.
  ['git switch main && git pull && git switch feature && git push', ['|git switch main [&&]', '|git pull [&&]', '|git switch feature [&&]', '|git push []']],
  ['git switch main; git push', ['|git switch main [;]', '|git push []']],
  ['a || b | c & d\ne', ['|a [||]', '|b [|]', '|c [&]', '|d [\n]', '|e []']],
  ['(cd sub && make)', ['|cd sub [&&]', '|make [)] cd']],
  ['npm test 2>&1 | tail -20', ['|npm test 2>&1 [|]', '|tail -20 []']],
  ['make &>/dev/null', ['|make &>/dev/null []']],
  // Quoting, escaping, and expansions.
  ['git commit -m "fix; rm -rf /"', ['|git commit -m fix; rm -rf / []']],
  ["'gh' 'repo' 'delete' x", ['|gh repo delete x []']],
  ['r\\m -rf /', ['|rm -rf / []']],
  ['echo "$HOME" $(date) `id`', ['|echo $$HOME $$(date) $`id` []']],
  ['bash <(curl -fsSL https://x)', ['AMBIGUOUS']],
  ['diff <(sort a) <(sort b)', ['|diff $<(sort a) $<(sort b) []']],
  ['g{it,noop} push', ['AMBIGUOUS']],
  ['echo {a..c} stash@{0} {}', ['|echo ${a..c} stash@{0} {} []']],
  ['echo "unterminated', 'ERROR unterminated quote'],
  ['echo $(date', 'ERROR unterminated expansion'],
  ['echo \\', 'ERROR trailing escape'],
  // Executable paths and globs.
  ['/bin/rm -rf /', ['|/bin/rm -rf / []']],
  ['/usr/bin/git --no-pager push', ['|/usr/bin/git --no-pager push []']],
  ['r* -rf /', ['AMBIGUOUS']],
  ['[ -f .env ] && echo present', ['|[ -f .env ] [&&]', '|echo present []']],
  // Wrappers.
  ['sudo --', ['AMBIGUOUS']],
  ['sudo -- rm -rf /', ['sudo|rm -rf / []']],
  ['sudo -u root -E rm x', ['sudo|rm x []']],
  ['sudo -D /tmp rm x', ['AMBIGUOUS']],
  ['sudo -- sudo -- sudo -- git commit -m x', ['sudo+sudo+sudo|git commit -m x []']],
  ['env FOO=1 -u BAR git status', ['env|git status []']],
  ['env PATH=/tmp rm x', ['AMBIGUOUS']],
  ['GIT_DIR=/x git commit', ['AMBIGUOUS']],
  ['env -C / rm -rf /', ['AMBIGUOUS']],
  ['nice rm -rf /', ['nice|rm -rf / []']],
  ['nice -n 10 npm run build', ['nice|npm run build []']],
  ['nice -5 make', ['nice|make []']],
  ['timeout 5 rm -rf /', ['timeout|rm -rf / []']],
  ['timeout -s KILL --preserve-status 1m npm test', ['timeout|npm test []']],
  ['timeout', ['AMBIGUOUS']],
  ['echo x | xargs git commit -am', ['|echo x [|]', 'xargs|git commit -am <P> []']],
  ['xargs -0 -n1 -P4 rm -f', ['xargs|rm -f <P> []']],
  ['xargs -I{} cp {} build/', ['xargs|cp <P> build/ []']],
  ['xargs --replace=@ mv @ @.bak', ['xargs|mv <P> <P> []']],
  ['xargs', ['xargs|echo <P> []']],
  ['xargs --bogus rm', ['AMBIGUOUS']],
  ['exec time noglob command nohup git status', ['exec+time+noglob+command+nohup|git status []']],
  ['command -v git', ['|command -v git []']],
  ["bash -lc 'git status && rm -rf /tmp/x'", ['bash|git status [&&]', 'bash|rm -rf /tmp/x []']],
  ["sudo bash -c 'rm -rf /tmp/x'", ['sudo+bash|rm -rf /tmp/x []']],
  ["sh -o pipefail -c 'git push -f'", ['sh|git push -f []']],
  ['bash script.sh', ['|bash script.sh []']],
  ["bash -c '$SCRIPT'", ['AMBIGUOUS']],
  ["eval 'git push --force'", ['eval|git push --force []']],
  ['bash -c "bash -c \\"bash -c \'bash -c true\'\\""', ['AMBIGUOUS']],
  // find actions.
  ['find . -name "*.tmp" -exec rm {} +', ['|find . -name *.tmp -exec rm {} + []', 'find|rm <P> []']],
  ['find . -maxdepth 0 -exec git commit -am x \\;', ['|find . -maxdepth 0 -exec git commit -am x ; []', 'find|git commit -am x []']],
  ["find . -execdir sh -c 'rm \"$1\"' _ {} \\;", ['|find . -execdir sh -c rm "$1" _ {} ; []', 'find+sh|rm $$1 []']],
  ['find . -exec rm', ['|find . -exec rm []']],
  // Compound commands and directory changes.
  ['if true; then rm -rf /; fi', ['|true [;]', '|rm -rf / [;]']],
  ['{ rm -rf /; }', ['|rm -rf / [;]']],
  ['function f { rm -rf /; }; f', ['|rm -rf / [;]', '|f []']],
  ['for f in a b; do echo "$f"; done', ['|echo $$f [;]']],
  ['cd sub && git commit -m x', ['|cd sub [&&]', '|git commit -m x [] cd']],
  ['pushd sub; git status; popd', ['|pushd sub [;]', '|git status [;] cd', '|popd [] cd']]
];

test('the shell module normalizes segments, operators, quoting, wrappers, and compound commands', () => {
  for (const [command, expected] of SHELL_PROBES) assert.deepEqual(render(command), expected, command);
  assert.deepEqual(parseShellCommands(undefined), { commands: [] });
  assert.equal(parseShellCommands('x'.repeat(SHELL_MAX_COMMAND_BYTES + 1)).error, 'command exceeds analysis limit');
});

test('the shell module reads Git global options before the subcommand', () => {
  const git = (command) => gitInvocation(parseShellCommands(command).commands[0].tokens);
  const plain = git('/usr/bin/git -C sub --no-pager -c core.hooksPath=/dev/null -c alias.ci=commit --git-dir=.git --work-tree . push -f');
  assert.equal(plain.name, 'push');
  assert.deepEqual(plain.args.map((token) => token.value), ['-f']);
  assert.equal(plain.scoped, true);
  assert.deepEqual(plain.globals.directories, ['sub']);
  assert.equal(plain.globals.gitDir, '.git');
  assert.equal(plain.globals.workTree, '.');
  assert.deepEqual(plain.globals.config, [{ key: 'core.hookspath', value: '/dev/null' }, { key: 'alias.ci', value: 'commit' }]);
  assert.equal(git('git --no-pager log -1').scoped, false);
  assert.equal(git('git --config-env=core.hooksPath=HOOKS commit').globals.config[0].key, 'core.hookspath');
  assert.equal(git('git -C "$DIR" push').ambiguous, true);
  assert.equal(git('git "$SUB"').ambiguous, true);
  assert.equal(git('git -C').ambiguous, true);
  assert.equal(git('git --version').name, undefined);
});

const COMMIT_PROBES = [
  // [command, expected fields]
  ['git commit -m x', { found: true, worktree: false, noVerify: false, unsupportedScope: false, ignored: null }],
  ['npm test', { found: false }],
  ['echo "git commit"', { found: false }],
  ['git log --grep commit', { found: false }],
  ['git commit -am x', { worktree: true }],
  ['git commit -m x app.js', { worktree: true }],
  ['git add app.js && git commit -m x', { worktree: true }],
  ['git commit -m a && git add -A && git commit -m b', { worktree: true }],
  ['git add -f .env && git commit -m x', { worktree: true, ignored: { all: false, pathspecs: ['.env'] } }],
  ['git add --force -- .env secrets/ && git commit -m x', { ignored: { all: false, pathspecs: ['.env', 'secrets/'] } }],
  ['git add -fA && git commit -m x', { ignored: { all: true, pathspecs: [] } }],
  ['git add -f "$FILE" && git commit -m x', { ignored: { all: true, pathspecs: [] } }],
  ['git add .env && git commit -m x', { ignored: null }],
  ['git commit -nm x', { noVerify: true }],
  ['git commit -mn', { noVerify: false }],
  ['git commit app.js -n', { noVerify: true }],
  ['git commit --no-verify -m x', { noVerify: true }],
  ['git commit --no-ver -m x', { noVerify: true }],
  ['git -c core.hooksPath=/dev/null commit -m x', { noVerify: true }],
  ['git -C ../other commit -m x', { unsupportedScope: true }],
  ['cd sub && git commit -m x', { unsupportedScope: true }],
  ['echo x | xargs git commit -am', { found: true, worktree: true }],
  ['echo msg | xargs git commit -m', { found: true, worktree: true }],
  ['find . -maxdepth 0 -exec git commit -am x \\;', { found: true, worktree: true }],
  ["bash -lc 'git commit -m ok'", { found: true }],
  ['/usr/bin/git --no-pager commit -m x', { found: true }],
  // Aliases: configured, defined in the command, or passed with -c.
  ['git ci -am x', { found: true, worktree: true }],
  ['git config alias.ci commit && git ci -am x', { found: true, worktree: true }],
  ['git config --local alias.cm "commit -n" && git cm -m x', { found: true, noVerify: true }],
  ['git -c alias.zz=commit zz -m x', { found: true, worktree: false }],
  ['git config alias.ship "push --force origin feature:main" && git ship', { found: false }],
  ['git st', { found: false }],
  ['git unknown-tool', { found: false }],
  ['git sh', { found: true, unsupportedScope: true }],
  ['git config alias.q "$X" && git q', { ambiguous: true }],
  ['git config "$KEY" commit && git q', { ambiguous: true }],
  ['git loop', { ambiguous: true }],
  ['git config alias.status commit && git status', { found: false }],
  ['bash -c "$SCRIPT"', { ambiguous: true }],
  ['env GIT_DIR=$DIR git commit -m x', { ambiguous: true }]
];
const CONFIGURED = new Map([['ci', 'commit'], ['st', 'status'], ['sh', '!git commit -m shell'], ['loop', 'loop']]);

test('the commit-content module tells what the commands will commit', () => {
  for (const [command, expected] of COMMIT_PROBES) {
    const actual = analyzeCommitContent(command, { aliases: CONFIGURED });
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `${command}: ${key}`);
  }
  let reads = 0;
  analyzeCommitContent('git status && git commit -m x && npm test', { aliases: () => { reads += 1; return new Map(); } });
  assert.equal(reads, 0, 'built-in subcommands never read aliases');
  analyzeCommitContent('git st && git st', { aliases: () => { reads += 1; return CONFIGURED; } });
  assert.equal(reads, 1, 'aliases are read once per command');
});

test('commit option parsing follows git commit syntax', () => {
  const tokens = (text) => text.split(' ').map((value) => ({ value, dynamic: false }));
  for (const args of ['-am x', '-a -m x', '--all -m x', '-m x app.js', '-m x -- app.js', '--only -m x', '--include -m x', '-p', '--interactive', '--pathspec-from-file=list.txt']) {
    assert.equal(commitReadsWorkingTree(tokens(args)), true, args);
  }
  for (const args of ['-m x', '-F msg.txt', '--amend --no-edit', '-S -m x', '-Sdeadbeef -m x', '-C HEAD', '--author=me -m x', '-s -m x', '-uno -m x']) {
    assert.equal(commitReadsWorkingTree(tokens(args)), false, args);
  }
  for (const args of ['-n', '-nm x', '-anm x', 'file -n', '--no-verify', '--no-v']) assert.equal(commitSkipsHooks(tokens(args)), true, args);
  for (const args of ['-m -n', '-mn', '-m x', '--no-edit', '-F -n', '-- -n']) assert.equal(commitSkipsHooks(tokens(args)), false, args);
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

// Inputs that once stalled hooks (`sudo --`) or that stress every loop of the analysis.
const ADVERSARIAL = [
  'sudo --',
  'sudo -- sudo -- sudo --',
  'sudo -- '.repeat(20000),
  'nice '.repeat(40000),
  'xargs '.repeat(40000),
  'timeout 1 '.repeat(20000),
  'find . -exec '.repeat(15000),
  '$('.repeat(100000),
  '$(('.repeat(60000),
  '"$('.repeat(60000),
  '`'.repeat(200000),
  '<('.repeat(100000),
  '{'.repeat(200000),
  'a;'.repeat(100000),
  '&'.repeat(200000),
  "'".repeat(200001),
  '\\'.repeat(200001),
  'bash -c '.repeat(20000),
  'eval '.repeat(40000),
  `git ${'-c a=b '.repeat(30000)}commit`,
  `git commit ${'-n'.repeat(100000)}`,
  `x=${'y'.repeat(SHELL_MAX_COMMAND_BYTES - 2)}`
];
const TIME_LIMIT_MS = 2000;

test('the analysis terminates quickly on adversarial input', () => {
  const loops = new Map([...Array.from({ length: 50 }, (_, index) => [`a${index}`, `a${index + 1}`]), ['a50', 'a0'], ['self', 'self']]);
  for (const command of [...ADVERSARIAL, 'git a0', 'git self']) {
    const started = performance.now();
    parseShellCommands(command);
    analyzeCommitContent(command, { aliases: loops });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < TIME_LIMIT_MS, `${JSON.stringify(command.slice(0, 40))} took ${Math.round(elapsed)} ms`);
  }
  assert.deepEqual(analyzeCommitContent('git a0', { aliases: loops }), { ambiguous: true });
});

function sharedShellPayloads() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.mjs') && readFileSync(next, 'utf8').includes('// <youdede:shared shell>')) files.push(next);
    }
  };
  walk(path.resolve('artifacts'));
  return files;
}

test('every hook with the shared shell block ends in bounded time as a process', { timeout: 10 * 60 * 1000 }, (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-shared-shell-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const payloads = sharedShellPayloads();
  assert.ok(payloads.length >= 2, 'the pilot hooks embed the shared shell block');
  for (const script of payloads) {
    for (const command of ['sudo --', 'sudo -- sudo -- git commit -m x', 'sudo -- '.repeat(20000), '$('.repeat(100000), 'find . -exec '.repeat(15000)]) {
      const started = performance.now();
      const result = spawnSync(process.execPath, [script], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: directory }),
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000
      });
      const label = `${path.basename(script)} ${JSON.stringify(command.slice(0, 30))}`;
      assert.equal(result.signal, null, `${label} was killed after ${Math.round(performance.now() - started)} ms`);
      assert.ok([0, 2].includes(result.status), `${label} exited ${result.status}`);
    }
  }
});

test('the generator keeps every shared block in sync and rejects broken markers', () => {
  const { problems, stale, embedded } = generateSharedHooks({ check: true });
  assert.deepEqual(problems, []);
  assert.deepEqual(stale, []);
  assert.ok(embedded >= 2);

  const modules = loadSharedModules();
  const block = (name) => `// <youdede:shared ${name}>\n// </youdede:shared>`;
  const rendered = renderSharedBlocks(`a\n${block('shell')}\n${block('commit-content')}\nb\n`, modules);
  assert.deepEqual(rendered.errors, []);
  assert.equal(renderSharedBlocks(rendered.text, modules).text, rendered.text, 'rendering is idempotent');
  assert.ok(rendered.text.includes('export function parseShellCommands'));
  assert.doesNotMatch(rendered.text, /^import /m);

  const errors = (source) => renderSharedBlocks(source, modules).errors.join('\n');
  assert.match(errors(`${block('shell')}\n${block('shell')}`), /duplicate shared block shell/);
  assert.match(errors('// <youdede:shared shell>\nx'), /shell is not closed/);
  assert.match(errors('x\n// </youdede:shared>'), /closes without an opening marker/);
  assert.match(errors('// <youdede:shared shell>\n// <youdede:shared commit-content>\n// </youdede:shared>'), /opens inside shell/);
  assert.match(errors(block('nope')), /unknown shared module nope/);
  assert.match(errors('// <youdede:shared shell >\n// </youdede:shared>'), /malformed shared marker/);
  assert.match(errors('//<youdede:shared shell>'), /malformed shared marker/);
  assert.match(errors(block('commit-content')), /commit-content requires the shell block/);
});
