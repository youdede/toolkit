import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cleanGitEnvironment } from './git-env.mjs';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  MAX_PATH_BYTES,
  MAX_STDIN_BYTES as WORKSPACE_MAX_STDIN,
  collectContext as collectWorkspace,
  evaluate as evaluateWorkspace
} from '../artifacts/hooks/security/application-security/workspace-boundary-guard/targets/claude-code/workspace-boundary-guard.mjs';
import {
  MAX_COMMAND_BYTES,
  GIT_BUDGET_MS,
  GIT_TIMEOUT_MS,
  MAX_STDIN_BYTES as BRANCH_MAX_STDIN,
  collectContext as collectBranch,
  evaluate as evaluateBranch,
  normalizeShell
} from '../artifacts/hooks/operations/git/protected-branch-guard/targets/claude-code/protected-branch-guard.mjs';
import { evaluate as evaluateShell } from '../artifacts/hooks/security/application-security/shell-command-guard/targets/claude-code/shell-command-guard.mjs';

// The guards prefer CLAUDE_PROJECT_DIR over the payload cwd, so a value
// inherited from a Claude Code hook would redirect fixtures at the real
// repository. Clear it; tests that need it pass it explicitly per spawn.
delete process.env.CLAUDE_PROJECT_DIR;

const WORKSPACE_SCRIPT = path.resolve('artifacts/hooks/security/application-security/workspace-boundary-guard/targets/claude-code/workspace-boundary-guard.mjs');
const BRANCH_SCRIPT = path.resolve('artifacts/hooks/operations/git/protected-branch-guard/targets/claude-code/protected-branch-guard.mjs');

function temporary(context, prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(cwd, args, expected = 0) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnvironment() });
  assert.equal(result.status, expected, result.stderr);
  return result.stdout.trim();
}

function initRepository(directory, branch = 'main', commit = true) {
  git(directory, ['init', '-q', '-b', branch]);
  git(directory, ['config', 'user.email', 'tests@youdede.invalid']);
  git(directory, ['config', 'user.name', 'youdede tests']);
  if (commit) {
    writeFileSync(path.join(directory, 'README.md'), 'baseline\n');
    git(directory, ['add', 'README.md']);
    git(directory, ['commit', '-qm', 'baseline']);
  }
}

function workspaceDecision(input, root) {
  return evaluateWorkspace(input, collectWorkspace(input, { cwd: root, env: {} }));
}

function branchDecision(input, cwd) {
  return evaluateBranch(input, collectBranch(input, { cwd, env: {} }));
}

test('workspace boundary allows contained native targets and ignores non-mutation tools', (context) => {
  const root = temporary(context, 'youdede-workspace-contained-');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'app.js'), 'export {}\n');
  mkdirSync(path.join(root, 'inside'));
  symlinkSync('inside', path.join(root, 'inside-link'));

  for (const input of [
    { tool_name: 'Write', cwd: root, tool_input: { file_path: 'src/new file.js', content: '' } },
    { tool_name: 'Edit', cwd: root, tool_input: { file_path: 'src/app.js', old_string: '', new_string: '' } },
    { tool_name: 'MultiEdit', cwd: root, tool_input: { file_path: 'src/app.js', edits: [] } },
    { tool_name: 'NotebookEdit', cwd: root, tool_input: { notebook_path: 'notebooks/demo.ipynb' } },
    { tool_name: 'Write', cwd: root, tool_input: { file_path: 'inside-link/new.txt', content: '' } }
  ]) assert.equal(workspaceDecision(input, root).exitCode, 0, JSON.stringify(input));

  const read = { tool_name: 'Read', cwd: root, tool_input: { file_path: '../outside.txt' } };
  assert.equal(workspaceDecision(read, root).exitCode, 0);
});

test('workspace boundary blocks lexical traversal and absolute escape without echoing targets', (context) => {
  const parent = temporary(context, 'youdede-workspace-escape-');
  const root = path.join(parent, 'project');
  mkdirSync(root);
  const outside = path.join(parent, 'outside.txt');

  for (const filePath of ['../outside.txt', outside]) {
    const input = { tool_name: 'Write', cwd: root, tool_input: { file_path: filePath, content: '' } };
    const result = workspaceDecision(input, root);
    assert.equal(result.ruleId, 'workspace-lexical-escape');
    assert.doesNotMatch(result.message, /outside\.txt/);
  }
});

test('workspace boundary checks the canonical nearest existing ancestor', (context) => {
  const parent = temporary(context, 'youdede-workspace-symlink-');
  const root = path.join(parent, 'project');
  const outside = path.join(parent, 'external');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'existing.txt'), 'outside\n');
  symlinkSync(outside, path.join(root, 'escape-link'));

  for (const filePath of ['escape-link/existing.txt', 'escape-link/missing/child.txt']) {
    const input = { tool_name: 'Edit', cwd: root, tool_input: { file_path: filePath, new_string: '' } };
    assert.equal(workspaceDecision(input, root).ruleId, 'workspace-symlink-escape', filePath);
  }

  symlinkSync(path.join(outside, 'missing-target'), path.join(root, 'broken-link'));
  const broken = { tool_name: 'Write', cwd: root, tool_input: { file_path: 'broken-link', content: '' } };
  assert.equal(workspaceDecision(broken, root).ruleId, 'workspace-boundary-unverified');
});

test('workspace boundary accepts a canonical absolute target beneath a symlinked project root', (context) => {
  const parent = temporary(context, 'youdede-workspace-root-alias-');
  const realRoot = path.join(parent, 'real-project');
  const aliasRoot = path.join(parent, 'project-alias');
  mkdirSync(path.join(realRoot, 'src'), { recursive: true });
  symlinkSync(realRoot, aliasRoot);
  const input = {
    tool_name: 'Write',
    tool_input: { file_path: path.join(realRoot, 'src', 'app.js'), content: '' }
  };
  const collected = collectWorkspace(input, { cwd: parent, env: { CLAUDE_PROJECT_DIR: aliasRoot } });
  assert.equal(evaluateWorkspace(input, collected).exitCode, 0);
});

test('workspace boundary uses CLAUDE_PROJECT_DIR before input cwd and bounds path fields', (context) => {
  const parent = temporary(context, 'youdede-workspace-root-');
  const root = path.join(parent, 'project');
  const other = path.join(parent, 'other');
  mkdirSync(root);
  mkdirSync(other);

  const input = { tool_name: 'Write', cwd: other, tool_input: { file_path: 'note.txt', content: '' } };
  const environmentContext = collectWorkspace(input, { cwd: parent, env: { CLAUDE_PROJECT_DIR: root } });
  assert.equal(evaluateWorkspace(input, environmentContext).exitCode, 0);

  const missing = { tool_name: 'Edit', cwd: root, tool_input: {} };
  assert.equal(workspaceDecision(missing, root).ruleId, 'workspace-target-missing');
  const nonString = { tool_name: 'Edit', cwd: root, tool_input: { file_path: 42 } };
  assert.equal(workspaceDecision(nonString, root).ruleId, 'workspace-target-invalid');
  const control = { tool_name: 'Edit', cwd: root, tool_input: { file_path: 'a\nfile' } };
  assert.equal(workspaceDecision(control, root).ruleId, 'workspace-target-invalid');
  const large = { tool_name: 'Edit', cwd: root, tool_input: { file_path: 'x'.repeat(MAX_PATH_BYTES + 1) } };
  assert.equal(workspaceDecision(large, root).ruleId, 'workspace-path-too-large');
});

test('protected branch discovery covers protected, feature, unborn, detached, and non-repository states', (context) => {
  assert.equal(GIT_TIMEOUT_MS, 3000);
  const main = temporary(context, 'youdede-branch-main-');
  initRepository(main, 'main');
  const native = { tool_name: 'Write', cwd: main, tool_input: { file_path: 'src/app.js', content: '' } };
  assert.equal(branchDecision(native, main).ruleId, 'protected-branch-native-mutation');

  git(main, ['switch', '-qc', 'feature/safe']);
  assert.equal(branchDecision({ ...native, cwd: main }, main).exitCode, 0);

  const unborn = temporary(context, 'youdede-branch-unborn-');
  initRepository(unborn, 'main', false);
  const unbornContext = collectBranch({ ...native, cwd: unborn }, { cwd: unborn, env: {} });
  assert.equal(unbornContext.currentBranch, 'main');
  assert.equal(evaluateBranch({ ...native, cwd: unborn }, unbornContext).ruleId, 'protected-branch-native-mutation');

  git(main, ['checkout', '-q', '--detach', 'HEAD']);
  const detachedContext = collectBranch({ ...native, cwd: main }, { cwd: main, env: {} });
  assert.equal(detachedContext.detached, true);
  assert.equal(evaluateBranch({ ...native, cwd: main }, detachedContext).exitCode, 0);

  const plain = temporary(context, 'youdede-branch-plain-');
  const plainContext = collectBranch({ ...native, cwd: plain }, { cwd: plain, env: {} });
  assert.equal(plainContext.repo, false);
  assert.equal(plainContext.inspectionError, false);
  assert.equal(evaluateBranch({ ...native, cwd: plain }, plainContext).exitCode, 0);
});

test('protected branch discovers a nonconventional default branch without network access', (context) => {
  const root = temporary(context, 'youdede-branch-default-');
  initRepository(root, 'trunk');
  git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  const input = { tool_name: 'NotebookEdit', cwd: root, tool_input: { notebook_path: 'analysis.ipynb' } };
  const discovered = collectBranch(input, { cwd: root, env: {} });
  assert.equal(discovered.defaultBranch, 'trunk');
  assert.equal(evaluateBranch(input, discovered).ruleId, 'protected-branch-native-mutation');
});

test('protected branch discovery follows Git worktree branch ownership', (context) => {
  const parent = temporary(context, 'youdede-branch-worktree-');
  const primary = path.join(parent, 'primary');
  const worktree = path.join(parent, 'feature-worktree');
  mkdirSync(primary);
  initRepository(primary, 'main');
  git(primary, ['branch', 'feature/worktree']);
  git(primary, ['worktree', 'add', '-q', worktree, 'feature/worktree']);

  const input = { tool_name: 'Edit', cwd: worktree, tool_input: { file_path: 'README.md', new_string: 'x' } };
  const discovered = collectBranch(input, { cwd: worktree, env: {} });
  assert.equal(discovered.currentBranch, 'feature/worktree');
  assert.equal(evaluateBranch(input, discovered).exitCode, 0);
});

test('protected branch blocks static history mutations only on the protected current branch', (context) => {
  const root = temporary(context, 'youdede-branch-history-');
  initRepository(root, 'main');
  const blocked = ['git commit -m change', 'git merge feature', 'git rebase feature', 'git reset --soft HEAD~1', 'git cherry-pick abc123'];
  for (const command of blocked) {
    const input = { tool_name: 'Bash', cwd: root, tool_input: { command } };
    assert.equal(branchDecision(input, root).ruleId, 'protected-branch-history-mutation', command);
  }

  for (const command of ['git status', 'git diff', 'git branch --show-current', 'git checkout feature', 'git merge --abort', 'git rebase --quit']) {
    const input = { tool_name: 'Bash', cwd: root, tool_input: { command } };
    assert.equal(branchDecision(input, root).exitCode, 0, command);
  }

  git(root, ['switch', '-qc', 'feature/history']);
  const featureCommit = { tool_name: 'Bash', cwd: root, tool_input: { command: 'git commit -m change' } };
  assert.equal(branchDecision(featureCommit, root).exitCode, 0);
});

test('protected branch refuses history rewriters on any branch', (context) => {
  const root = temporary(context, 'youdede-branch-rewriters-');
  initRepository(root, 'main');
  git(root, ['switch', '-qc', 'feature/rewrite']);
  for (const command of ['git filter-branch -f --msg-filter cat HEAD', 'git filter-branch -- --all', 'git filter-repo --force', 'git fast-export --all | git fast-import', 'sudo git filter-branch']) {
    const input = { tool_name: 'Bash', cwd: root, tool_input: { command } };
    assert.equal(branchDecision(input, root).ruleId, 'protected-branch-history-mutation', command);
  }
  const exported = { tool_name: 'Bash', cwd: root, tool_input: { command: 'git fast-export --all > history.dump' } };
  assert.equal(branchDecision(exported, root).exitCode, 0);
});

test('protected branch blocks protected local deletion and direct remote destinations', (context) => {
  const root = temporary(context, 'youdede-branch-targets-');
  initRepository(root, 'main');
  git(root, ['switch', '-qc', 'feature/push']);

  const cases = [
    ['git branch -D main', 'protected-branch-delete'],
    ['git branch --delete master', 'protected-branch-delete'],
    ['git update-ref -d refs/heads/main', 'protected-branch-delete'],
    ['git update-ref refs/heads/main HEAD', 'protected-branch-update'],
    ['git branch -f main HEAD', 'protected-branch-update'],
    ['git checkout -B main HEAD', 'protected-branch-update'],
    ['git switch -C main HEAD', 'protected-branch-update'],
    ['git push origin main', 'protected-branch-direct-push'],
    ['git push origin feature/push:main', 'protected-branch-direct-push'],
    ['git push origin refs/heads/feature/push:refs/heads/main', 'protected-branch-direct-push'],
    ['git push origin --delete main', 'protected-branch-delete'],
    ['git push origin :main', 'protected-branch-delete'],
    ['git push --all origin', 'protected-branch-direct-push'],
    ['git push --mirror origin', 'protected-branch-direct-push'],
    ["git push origin 'refs/heads/*:refs/heads/*'", 'protected-git-command-uninspectable'],
    ['git push', 'protected-git-command-uninspectable'],
    ['git push origin', 'protected-git-command-uninspectable']
  ];
  for (const [command, ruleId] of cases) {
    const input = { tool_name: 'Bash', cwd: root, tool_input: { command } };
    assert.equal(branchDecision(input, root).ruleId, ruleId, command);
  }

  for (const command of [
    'git branch -d old-feature',
    'git push origin feature/push:feature/push',
    'git push --dry-run origin main',
    'echo "git push origin main"'
  ]) {
    const input = { tool_name: 'Bash', cwd: root, tool_input: { command } };
    assert.equal(branchDecision(input, root).exitCode, 0, command);
  }
});

test('protected branch parser handles wrappers and refuses dynamic or shifted Git scope', (context) => {
  const root = temporary(context, 'youdede-branch-wrapper-');
  initRepository(root, 'main');
  git(root, ['switch', '-qc', 'feature/wrapper']);
  const blocked = [
    ['exec time noglob command env FOO=x git push origin main', 'protected-branch-direct-push'],
    ['nice git push origin main', 'protected-branch-direct-push'],
    ['timeout 30 git push origin main', 'protected-branch-direct-push'],
    ["bash -lc 'git branch -D main'", 'protected-branch-delete'],
    // Substitutions are read, so the push inside is judged itself (W3-REVIEW-2).
    ['echo $(git push origin main)', 'protected-branch-direct-push'],
    ['echo `git push origin main`', 'protected-branch-direct-push'],
    ['git status && echo "$(git switch main && git push)"', 'protected-branch-direct-push'],
    ['echo $(echo $(echo $(echo $(git push origin main))))', 'protected-command-uninspectable'],
    // The item parser reads env -C as a directory change.
    ['env -C ../other git commit -m x', 'protected-git-scope-uninspectable'],
    ['GIT_WORK_TREE=$TREE git commit -m x', 'protected-command-uninspectable'],
    ['cd ../other && git commit -m x', 'protected-git-scope-uninspectable'],
    ['git -C ../other commit -m x', 'protected-git-command-uninspectable'],
    ['git push origin $TARGET', 'protected-git-command-uninspectable'],
    ["git push origin 'main", 'protected-command-uninspectable']
  ];
  for (const [command, ruleId] of blocked) {
    const input = { tool_name: 'Bash', cwd: root, tool_input: { command } };
    assert.equal(branchDecision(input, root).ruleId, ruleId, command);
  }

  // A program known only at run time belongs to shell-command-guard (option B, hook-design 1.7).
  assert.equal(branchDecision({ tool_name: 'Bash', cwd: root, tool_input: { command: "bash -c '$SCRIPT'" } }, root).exitCode, 0);
  assert.equal(evaluateShell({ tool_input: { command: "bash -c '$SCRIPT'" } }).ruleId, 'shell-command-uninspectable');

  assert.deepEqual(normalizeShell("bash -lc 'git status'").invocations.map((tokens) => tokens.map((token) => token.value)), [['git', 'status']]);
});

test('protected branch fails closed when Git inspection itself fails', () => {
  const input = { tool_name: 'Write', cwd: '/untrusted', tool_input: { file_path: 'file.txt', content: '' } };
  const context = collectBranch(input, {
    cwd: '/',
    env: {},
    runGit: () => ({ error: new Error('timed out'), status: null, stdout: '', stderr: '' })
  });
  assert.equal(context.inspectionError, true);
  assert.equal(evaluateBranch(input, context).ruleId, 'protected-branch-unverified');
  // Without the alias table an unknown subcommand may be an alias for a protected push.
  const bash = (command) => evaluateBranch({ tool_name: 'Bash', tool_input: { command } }, context);
  assert.equal(bash('git ship').ruleId, 'protected-branch-unverified');
  assert.equal(bash('git status && git log -1').exitCode, 0);
});

test('new hook wrappers use stable process exits for valid, blocked, malformed, and oversized input', (context) => {
  const workspace = temporary(context, 'youdede-boundary-process-');
  mkdirSync(path.join(workspace, 'src'));
  const safeWorkspace = spawnSync(process.execPath, [WORKSPACE_SCRIPT], {
    input: JSON.stringify({ tool_name: 'Write', cwd: workspace, tool_input: { file_path: 'src/app.js', content: '' } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: workspace }
  });
  assert.equal(safeWorkspace.status, 0, safeWorkspace.stderr);
  const blockedWorkspace = spawnSync(process.execPath, [WORKSPACE_SCRIPT], {
    input: JSON.stringify({ tool_name: 'Write', cwd: workspace, tool_input: { file_path: '../outside-secret.txt', content: '' } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: workspace }
  });
  assert.equal(blockedWorkspace.status, 2);
  assert.match(blockedWorkspace.stderr, /workspace-lexical-escape/);
  assert.doesNotMatch(blockedWorkspace.stderr, /outside-secret/);

  const repository = temporary(context, 'youdede-branch-process-');
  initRepository(repository, 'main');
  const blockedBranch = spawnSync(process.execPath, [BRANCH_SCRIPT], {
    input: JSON.stringify({ tool_name: 'Write', cwd: repository, tool_input: { file_path: 'src/app.js', content: '' } }),
    encoding: 'utf8'
  });
  assert.equal(blockedBranch.status, 2);
  assert.match(blockedBranch.stderr, /protected-branch-native-mutation/);

  for (const [name, script, limit] of [
    ['workspace', WORKSPACE_SCRIPT, WORKSPACE_MAX_STDIN],
    ['branch', BRANCH_SCRIPT, BRANCH_MAX_STDIN]
  ]) {
    const malformed = spawnSync(process.execPath, [script], { input: '{bad', encoding: 'utf8' });
    assert.equal(malformed.status, 2, name);
    assert.match(malformed.stderr, /input-invalid/, name);
    const oversized = spawnSync(process.execPath, [script], { input: 'x'.repeat(limit + 1), encoding: 'utf8' });
    assert.equal(oversized.status, 2, name);
    assert.match(oversized.stderr, /input-invalid/, name);
  }

  const oversizedCommand = evaluateBranch(
    { tool_name: 'Bash', tool_input: { command: 'x'.repeat(MAX_COMMAND_BYTES + 1) } },
    { repo: true, currentBranch: 'feature', defaultBranch: 'main' }
  );
  assert.equal(oversizedCommand.ruleId, 'protected-command-too-large');
});

test('protected branch resolves push destinations, aliases, push mappings, and command runners', (context) => {
  const parent = temporary(context, 'youdede-branch-config-');
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'work');
  mkdirSync(root);
  git(parent, ['init', '-q', '--bare', remote]);
  initRepository(root, 'main');
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  git(root, ['switch', '-qc', 'feature/config']);
  git(root, ['push', '-q', '-u', 'origin', 'feature/config']);
  const decide = (command) => branchDecision({ tool_name: 'Bash', cwd: root, tool_input: { command } }, root);

  assert.equal(decide('git push').exitCode, 0);
  assert.equal(decide('git push origin').exitCode, 0);
  assert.equal(decide('git push --force').exitCode, 0);

  git(root, ['branch', '-q', '-u', 'origin/main']);
  git(root, ['config', 'push.default', 'upstream']);
  assert.equal(decide('git push').ruleId, 'protected-branch-direct-push');
  git(root, ['config', '--unset', 'push.default']);
  git(root, ['branch', '-q', '-u', 'origin/feature/config']);

  git(root, ['config', 'alias.ship', 'push --force origin feature/config:main']);
  assert.equal(decide('git ship').ruleId, 'protected-branch-direct-push');
  git(root, ['config', 'alias.st', 'status']);
  assert.equal(decide('git st').exitCode, 0);
  git(root, ['config', 'alias.run', '!git push origin feature/config:main']);
  assert.equal(decide('git run').ruleId, 'protected-git-command-uninspectable');

  git(root, ['config', 'remote.origin.push', 'refs/heads/feature/config:refs/heads/main']);
  assert.equal(decide('git push origin feature/config').ruleId, 'protected-git-command-uninspectable');
  assert.equal(decide('git push').ruleId, 'protected-branch-direct-push');
  assert.equal(decide('git push origin feature/config:feature/config').exitCode, 0);
  git(root, ['config', '--unset', 'remote.origin.push']);

  assert.equal(decide(`git send-pack ${remote} feature/config:main`).ruleId, 'protected-git-command-uninspectable');
  assert.equal(decide('echo main | xargs git push origin').ruleId, 'protected-command-uninspectable');
  assert.equal(decide('find . -maxdepth 0 -exec git push origin feature/config:main \;').ruleId, 'protected-command-uninspectable');
  assert.equal(decide('find . -name "*.md" -exec git status \;').exitCode, 0);
});

test('protected branch checks later Git commands against every branch an earlier command can switch to', (context) => {
  const parent = temporary(context, 'youdede-branch-sequence-');
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'work');
  mkdirSync(root);
  git(parent, ['init', '-q', '--bare', remote]);
  initRepository(root, 'main');
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  git(root, ['switch', '-qc', 'feature']);
  git(root, ['push', '-q', '-u', 'origin', 'feature']);
  const decide = (command) => branchDecision({ tool_name: 'Bash', cwd: root, tool_input: { command } }, root);

  for (const [command, ruleId] of [
    ['git switch main && git merge feature && git push', 'protected-branch-history-mutation'],
    ['git checkout main; git commit --allow-empty -m x', 'protected-branch-history-mutation'],
    ['git switch main; git push', 'protected-branch-direct-push'],
    ['git rebase feature main', 'protected-branch-history-mutation'],
    ['git switch other && git push', 'protected-git-sequence-uninspectable'],
    ['git checkout - && git push origin HEAD', 'protected-git-sequence-uninspectable'],
    ['gh pr checkout 12 && git commit -m x', 'protected-git-sequence-uninspectable'],
    ['git config push.default upstream && git push', 'protected-git-sequence-uninspectable'],
    ['git config alias.ship "push --force origin feature:main" && git ship', 'protected-branch-direct-push'],
    ['git config alias.x "$V" && git x', 'protected-git-sequence-uninspectable'],
    ['git fetch . feature:main', 'protected-branch-update'],
    ['git switch main && git pull origin feature', 'protected-branch-history-mutation'],
    ['cd .. && cd work && git pull origin feature', 'protected-git-scope-uninspectable'],
    ['git worktree add -B main ../wt feature', 'protected-branch-update']
  ]) assert.equal(decide(command).ruleId, ruleId, command);

  for (const command of [
    'git push',
    'git switch other && git push origin feature',
    'git switch -c feature/y && git push -u origin feature/y',
    'git checkout src/app.js && git commit -m x',
    'git fetch && git rebase origin/main && git push --force-with-lease',
    'git stash && git switch main && git pull && git switch feature && git stash pop',
    'git fetch origin main:main',
    'git worktree add -b feature/wt ../wt'
  ]) assert.equal(decide(command).exitCode, 0, command);

  git(root, ['switch', '-q', 'main']);
  assert.equal(decide('git pull origin feature').ruleId, 'protected-branch-history-mutation');
  assert.equal(decide('git pull').exitCode, 0);
  assert.equal(decide('git pull origin main').exitCode, 0);
});

test('protected branch keeps all Git subprocesses inside one budget below the adapter timeout', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    const timeouts = [];
    const context = collectBranch({ tool_name: 'Write', tool_input: {} }, {
      cwd: '/',
      env: {},
      runGit: (root, args, options) => {
        timeouts.push(options.timeout);
        mock.timers.tick(GIT_TIMEOUT_MS);
        return { status: 0, stdout: args[0] === 'symbolic-ref' ? 'feature' : '.git', stderr: '' };
      }
    });
    assert.equal(context.inspectionError, true);
    assert.deepEqual(timeouts, [GIT_TIMEOUT_MS, GIT_TIMEOUT_MS, GIT_BUDGET_MS - 2 * GIT_TIMEOUT_MS]);
  } finally {
    mock.timers.reset();
  }
});
