import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanGitEnvironment } from './git-env.mjs';

import {
  scanReferences,
  evaluate as evaluateCi
} from '../artifacts/hooks/security/ci-references/ci-reference-pinning-guard/targets/claude-code/ci-reference-pinning-guard.mjs';
import {
  scanDependencySources,
  evaluate as evaluateDependencySource
} from '../artifacts/hooks/security/dependency-origins/dependency-source-guard/targets/claude-code/dependency-source-guard.mjs';
import {
  lifecycleEntries,
  evaluate as evaluateLifecycle
} from '../artifacts/hooks/security/lifecycle-scripts/install-lifecycle-script-guard/targets/claude-code/install-lifecycle-script-guard.mjs';
import {
  scanPackageLock,
  evaluate as evaluateLockfileOrigin
} from '../artifacts/hooks/security/lockfile-origins/lockfile-origin-guard/targets/claude-code/lockfile-origin-guard.mjs';
import {
  inspectSubmoduleCommand,
  scanGitmodules,
  evaluate as evaluateSubmodule
} from '../artifacts/hooks/security/git-submodules/submodule-target-guard/targets/claude-code/submodule-target-guard.mjs';
import {
  inspectLinkTarget,
  evaluate as evaluateSymlink
} from '../artifacts/hooks/security/repository-links/symlink-publication-guard/targets/claude-code/symlink-publication-guard.mjs';
import {
  inspectExecutableAddition,
  evaluate as evaluateExecutable
} from '../artifacts/hooks/security/executable-content/executable-permission-guard/targets/claude-code/executable-permission-guard.mjs';
import {
  inspectPortablePath,
  evaluate as evaluatePortable
} from '../artifacts/hooks/operations/path-portability/path-portability-guard/targets/claude-code/path-portability-guard.mjs';
import {
  MAX_CHANGED_LINES,
  evaluate as evaluateLargeDiff
} from '../artifacts/hooks/operations/reviewability/large-diff-review-guard/targets/claude-code/large-diff-review-guard.mjs';
import {
  releaseIntent,
  evaluate as evaluateCleanRelease
} from '../artifacts/hooks/operations/repository-state/release-clean-state-guard/targets/claude-code/release-clean-state-guard.mjs';
import {
  inspectVersionState,
  nodePublishIntent,
  evaluate as evaluateVersion
} from '../artifacts/hooks/operations/versioning/release-version-consistency-guard/targets/claude-code/release-version-consistency-guard.mjs';
import {
  signingIntent,
  evaluate as evaluateSignature
} from '../artifacts/hooks/operations/signed-history/commit-signature-intent-guard/targets/claude-code/commit-signature-intent-guard.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAX_STDIN_BYTES = 1024 * 1024;
const SCRIPTS = {
  ci: 'artifacts/hooks/security/ci-references/ci-reference-pinning-guard/targets/claude-code/ci-reference-pinning-guard.mjs',
  dependency: 'artifacts/hooks/security/dependency-origins/dependency-source-guard/targets/claude-code/dependency-source-guard.mjs',
  lifecycle: 'artifacts/hooks/security/lifecycle-scripts/install-lifecycle-script-guard/targets/claude-code/install-lifecycle-script-guard.mjs',
  lockfile: 'artifacts/hooks/security/lockfile-origins/lockfile-origin-guard/targets/claude-code/lockfile-origin-guard.mjs',
  submodule: 'artifacts/hooks/security/git-submodules/submodule-target-guard/targets/claude-code/submodule-target-guard.mjs',
  symlink: 'artifacts/hooks/security/repository-links/symlink-publication-guard/targets/claude-code/symlink-publication-guard.mjs',
  executable: 'artifacts/hooks/security/executable-content/executable-permission-guard/targets/claude-code/executable-permission-guard.mjs',
  portability: 'artifacts/hooks/operations/path-portability/path-portability-guard/targets/claude-code/path-portability-guard.mjs',
  largeDiff: 'artifacts/hooks/operations/reviewability/large-diff-review-guard/targets/claude-code/large-diff-review-guard.mjs',
  cleanRelease: 'artifacts/hooks/operations/repository-state/release-clean-state-guard/targets/claude-code/release-clean-state-guard.mjs',
  releaseVersion: 'artifacts/hooks/operations/versioning/release-version-consistency-guard/targets/claude-code/release-version-consistency-guard.mjs',
  signature: 'artifacts/hooks/operations/signed-history/commit-signature-intent-guard/targets/claude-code/commit-signature-intent-guard.mjs'
};

function temporary(context, prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(context, prefix) {
  const directory = temporary(context, prefix);
  git(directory, ['init', '-q', '-b', 'main']);
  git(directory, ['config', 'user.email', 'tests@youdede.invalid']);
  git(directory, ['config', 'user.name', 'youdede tests']);
  writeFileSync(path.join(directory, 'README.md'), 'baseline\n');
  git(directory, ['add', 'README.md']);
  git(directory, ['commit', '-qm', 'baseline']);
  return directory;
}

function invoke(name, input, options = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, SCRIPTS[name])], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: options.cwd || ROOT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: options.project || '' }
  });
}

test('pure scanners block their exact boundary and preserve paired false positives', () => {
  const pinned = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(scanReferences(`- uses: actions/checkout@${pinned}\n`).length, 0);
  assert.equal(scanReferences('- uses: actions/checkout@v4\n')[0].ruleId, 'ci-reference-mutable');
  assert.equal(scanReferences('- { uses: actions/checkout@v4, with: { fetch-depth: 1 } }\n')[0].ruleId, 'ci-reference-mutable');
  assert.equal(scanReferences('- uses: ./local/action\n').length, 0);

  assert.equal(scanDependencySources('{"dependencies":{"safe":"^1.2.3"}}').length, 0);
  assert.equal(scanDependencySources('{"dependencies":{"unsafe":"git+https://example.invalid/repo.git"}}')[0].ruleId, 'dependency-source-bypass');
  assert.equal(scanDependencySources('{"scripts":{"fetch":"https://example.invalid"}}').length, 0);
  assert.equal(scanDependencySources('{"overrides":{"unsafe":"git+https://example.invalid/repo.git"}}')[0].ruleId, 'dependency-source-bypass');
  assert.equal(scanDependencySources('{"pnpm":{"overrides":{"unsafe":"file:../unsafe"}}}')[0].ruleId, 'dependency-source-bypass');

  assert.deepEqual(lifecycleEntries('{"scripts":{"test":"node --test"}}'), []);
  assert.deepEqual(lifecycleEntries('{"scripts":{"postinstall":"node setup.mjs"}}'), ['postinstall']);
  assert.deepEqual(lifecycleEntries('{"scripts":{"preprepare":"node pre.js","postprepare":"node post.js","dependencies":"node deps.js","pnpm:devPreinstall":"node dev.js"}}'), ['dependencies', 'pnpm:devPreinstall', 'postprepare', 'preprepare']);
  assert.deepEqual(lifecycleEntries('{"description":"postinstall"}'), []);

  assert.equal(scanPackageLock('{"packages":{"node_modules/a":{"resolved":"https://registry.invalid/a.tgz","integrity":"sha512-x"}}}').length, 0);
  assert.equal(scanPackageLock('{"packages":{"node_modules/a":{"resolved":"http://registry.invalid/a.tgz"}}}')[0].ruleId, 'lockfile-insecure-origin');
  assert.equal(scanPackageLock('{"packages":{"":{"resolved":"http://ignored.invalid/root"}}}').length, 0);

  assert.equal(scanGitmodules('[submodule "safe"]\n url = https://example.invalid/repo.git\n').length, 0);
  assert.equal(scanGitmodules('[submodule "unsafe"]\n url = ../repo.git\n')[0].ruleId, 'submodule-target-local');
  assert.equal(inspectSubmoduleCommand('git submodule add -b main https://example.invalid/repo.git module').ruleId, 'submodule-branch-tracking');
  assert.equal(inspectSubmoduleCommand('env MODE=safe /usr/bin/git submodule add http://example.invalid/repo.git module').ruleId, 'submodule-target-insecure');
  assert.equal(inspectSubmoduleCommand("bash -lc 'git submodule add ../repo.git module'").ruleId, 'submodule-target-local');
  assert.equal(inspectSubmoduleCommand('git status'), null);

  assert.equal(inspectLinkTarget('docs/current', '../README.md'), null);
  assert.equal(inspectLinkTarget('link', '../outside').ruleId, 'symlink-target-escape');
  assert.equal(inspectLinkTarget('docs/link', 'guide.md'), null);

  assert.equal(inspectExecutableAddition({ name: 'tool.sh', oldMode: '100644', newMode: '100755', prefix: '#!/bin/sh\n' }), null);
  assert.equal(inspectExecutableAddition({ name: 'settings.json', oldMode: '100644', newMode: '100755', prefix: '{}\n' }).ruleId, 'executable-declarative-file');
  assert.equal(inspectExecutableAddition({ name: 'tool.js', oldMode: '100755', newMode: '100755', prefix: 'no shebang' }), null);

  assert.equal(inspectPortablePath('src/app.ts', { exactExists: false, siblings: [] }), null);
  assert.equal(inspectPortablePath('docs/CON.txt', { exactExists: false, siblings: [] }).ruleId, 'portable-reserved-name');
  assert.equal(inspectPortablePath('src/app.ts', { exactExists: true, siblings: ['APP.TS'] }), null);

  assert.equal(releaseIntent('npm publish --dry-run'), 'irrelevant');
  assert.equal(releaseIntent('npm publish'), 'release');
  assert.equal(releaseIntent('env MODE=safe /usr/bin/npm --workspace package-a publish'), 'release');
  assert.equal(releaseIntent("bash -lc 'npm publish'"), 'release');
  assert.equal(releaseIntent('npm run build'), 'irrelevant');

  assert.equal(inspectVersionState({ name: 'toolkit', version: '1.2.3', private: false, lockVersions: ['1.2.3'] }), null);
  assert.equal(inspectVersionState({ name: 'toolkit', version: '1.2.3', private: false, lockVersions: ['1.2.2'] }).ruleId, 'release-version-mismatch');
  assert.equal(inspectVersionState({ name: 'toolkit', version: '1.2.3-beta.1', private: false, lockVersions: ['1.2.3-beta.1'] }), null);
  assert.equal(nodePublishIntent('npm publish ./release.tgz'), 'invalid');
  assert.equal(nodePublishIntent('npm --workspace package-a publish'), 'invalid');

  assert.deepEqual(signingIntent('git status'), { relevant: false });
  assert.equal(signingIntent('git commit -S -m signed').explicit, true);
  assert.equal(signingIntent('git commit --no-gpg-sign -m unsigned').explicitDisable, true);
  assert.equal(signingIntent('env MODE=safe /usr/bin/git commit -S -m signed').explicit, true);
  assert.equal(signingIntent("bash -lc 'git commit -S -m signed'").explicit, true);

  assert.equal(evaluateLifecycle({}, { relevant: true, oldText: '{"scripts":{"prepare":"node old.js"}}', newText: '{"scripts":{"prepare":"node new.js"}}' }).exitCode, 2);
  assert.equal(evaluateSubmodule({}, { relevant: true, before: '[submodule "x"]\n url = ../old.git\n', after: '[submodule "x"]\n url = ../new.git\n' }).exitCode, 2);
});

test('pure evaluators are stable across allow, block, malformed, oversized, and boundary contexts', () => {
  const decisions = [
    evaluateCi({}, { relevant: true, before: '', after: '- uses: vendor/action@v1\n' }),
    evaluateDependencySource({}, { relevant: true, before: '{}', after: '{"dependencies":{"x":"file:../x"}}' }),
    evaluateLifecycle({}, { relevant: true, oldText: '{}', newText: '{"scripts":{"prepare":"node setup.js"}}' }),
    evaluateLockfileOrigin({}, { relevant: true, staged: [{ content: '{"packages":{"node_modules/x":{"resolved":"http://x.invalid/a.tgz"}}}' }] }),
    evaluateSubmodule({}, { relevant: true, before: '', after: '[submodule "x"]\n branch = main\n url = https://example.invalid/x.git\n' }),
    evaluateSymlink({}, { relevant: true, links: [{ name: 'link', target: '/absolute' }] }),
    evaluateExecutable({}, { relevant: true, files: [{ name: 'data.json', oldMode: '100644', newMode: '100755', prefix: '{}' }] }),
    evaluatePortable({}, { relevant: true, candidate: 'AUX', exactExists: false, siblings: [] }),
    evaluateLargeDiff({}, { relevant: true, totals: { files: 1, changedLines: MAX_CHANGED_LINES + 1, binaryBytes: 0, largestBinaryBytes: 0 } }),
    evaluateCleanRelease({}, { relevant: true, state: { dirty: true, detached: false, operationInProgress: false } }),
    evaluateVersion({}, { relevant: true, state: { name: 'toolkit', version: '1.0.0', private: false, lockVersions: ['2.0.0'] } }),
    evaluateSignature({}, { relevant: true, explicit: false, configured: false })
  ];
  for (const result of decisions) assert.equal(result.exitCode, 2, result.ruleId);

  for (const evaluate of [
    evaluateCi, evaluateDependencySource, evaluateLifecycle, evaluateLockfileOrigin, evaluateSubmodule,
    evaluateSymlink, evaluateExecutable, evaluatePortable, evaluateLargeDiff, evaluateCleanRelease,
    evaluateVersion, evaluateSignature
  ]) {
    assert.equal(evaluate({}, { relevant: false }).exitCode, 0);
    assert.equal(evaluate({}, { relevant: true, invalid: true }).exitCode, 2);
  }

  assert.throws(() => scanReferences('x'.repeat(512 * 1024 + 1)), /oversized/);
  assert.throws(() => scanDependencySources('x'.repeat(384 * 1024 + 1)), /oversized/);
  assert.throws(() => lifecycleEntries('{'), /malformed/);
  assert.throws(() => scanPackageLock('{'), /malformed/);
});

test('every hook wrapper bounds stdin and rejects malformed envelopes', () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    assert.ok(script.endsWith('.mjs'), name);
    const malformed = invoke(name, '{TOP_SECRET_SENTINEL');
    assert.equal(malformed.status, 2, `${name}: ${malformed.stderr}`);
    assert.match(malformed.stderr, /input-invalid/, name);
    assert.doesNotMatch(malformed.stderr, /TOP_SECRET_SENTINEL/, name);

    const oversized = invoke(name, 'x'.repeat(MAX_STDIN_BYTES + 1));
    assert.equal(oversized.status, 2, `${name}: ${oversized.stderr}`);
    assert.match(oversized.stderr, /invalid|oversized/i, name);
  }
});

test('file and command wrappers expose paired process allow and block exits', (context) => {
  const directory = temporary(context, 'youdede-hook-files-');
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const cases = [
    ['ci',
      { cwd: directory, tool_name: 'Write', tool_input: { file_path: '.github/workflows/ci.yml', content: '- uses: vendor/action@v1\n' } },
      { cwd: directory, tool_name: 'Write', tool_input: { file_path: '.github/workflows/ci.yml', content: `- uses: vendor/action@${commit}\n` }}],
    ['dependency',
      { cwd: directory, tool_name: 'Write', tool_input: { file_path: 'package.json', content: '{"dependencies":{"x":"file:../x"}}' } },
      { cwd: directory, tool_name: 'Write', tool_input: { file_path: 'package.json', content: '{"dependencies":{"x":"^1.0.0"}}' } }],
    ['lifecycle',
      { cwd: directory, tool_name: 'Write', tool_input: { file_path: 'package.json', content: '{"scripts":{"postinstall":"node setup.js"}}' } },
      { cwd: directory, tool_name: 'Write', tool_input: { file_path: 'package.json', content: '{"scripts":{"test":"node --test"}}' } }],
    ['submodule',
      { cwd: directory, tool_name: 'Bash', tool_input: { command: 'git submodule add http://example.invalid/repo.git module' } },
      { cwd: directory, tool_name: 'Bash', tool_input: { command: 'git status' } }],
    ['portability',
      { cwd: directory, tool_name: 'Write', tool_input: { file_path: 'CON.txt', content: '' } },
      { cwd: directory, tool_name: 'Write', tool_input: { file_path: 'src/app.js', content: '' } }]
  ];
  for (const [name, blockedInput, allowedInput] of cases) {
    const blocked = invoke(name, blockedInput, { cwd: directory });
    assert.equal(blocked.status, 2, `${name}: ${blocked.stderr}`);
    const allowed = invoke(name, allowedInput, { cwd: directory });
    assert.equal(allowed.status, 0, `${name}: ${allowed.stderr}`);
  }
});

test('staged Git hooks inspect real index state without executing the submitted command', (context) => {
  const lockRoot = repository(context, 'youdede-lock-origin-');
  writeFileSync(path.join(lockRoot, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/x":{"resolved":"http://example.invalid/x.tgz"}}}\n');
  git(lockRoot, ['add', 'package-lock.json']);
  assert.equal(invoke('lockfile', { cwd: lockRoot, tool_input: { command: 'git commit -m release' } }, { cwd: lockRoot }).status, 2);
  assert.equal(invoke('lockfile', { cwd: lockRoot, tool_input: { command: 'git status' } }, { cwd: lockRoot }).status, 0);

  const linkRoot = repository(context, 'youdede-symlink-publication-');
  symlinkSync('../outside', path.join(linkRoot, 'escape-link'));
  git(linkRoot, ['add', 'escape-link']);
  assert.equal(invoke('symlink', { cwd: linkRoot, tool_input: { command: 'git commit -m link' } }, { cwd: linkRoot }).status, 2);
  assert.equal(invoke('symlink', { cwd: linkRoot, tool_input: { command: 'git status' } }, { cwd: linkRoot }).status, 0);

  const executableRoot = repository(context, 'youdede-executable-permission-');
  writeFileSync(path.join(executableRoot, 'metadata.json'), '{}\n');
  git(executableRoot, ['add', 'metadata.json']);
  git(executableRoot, ['update-index', '--chmod=+x', 'metadata.json']);
  assert.equal(invoke('executable', { cwd: executableRoot, tool_input: { command: 'git commit -m mode' } }, { cwd: executableRoot }).status, 2);
  assert.equal(invoke('executable', { cwd: executableRoot, tool_input: { command: 'git status' } }, { cwd: executableRoot }).status, 0);

  const diffRoot = repository(context, 'youdede-large-diff-');
  writeFileSync(path.join(diffRoot, 'large.txt'), Array.from({ length: MAX_CHANGED_LINES + 1 }, (_, index) => `line ${index}\n`).join(''));
  git(diffRoot, ['add', 'large.txt']);
  assert.equal(invoke('largeDiff', { cwd: diffRoot, tool_input: { command: 'git commit -m large' } }, { cwd: diffRoot }).status, 2);
  assert.equal(invoke('largeDiff', { cwd: diffRoot, tool_input: { command: 'git status' } }, { cwd: diffRoot }).status, 0);
});

test('release and signature wrappers enforce observable state with process exits', (context) => {
  const cleanRoot = repository(context, 'youdede-release-clean-');
  assert.equal(invoke('cleanRelease', { cwd: cleanRoot, tool_input: { command: 'npm publish' } }, { cwd: cleanRoot }).status, 0);
  writeFileSync(path.join(cleanRoot, 'README.md'), 'dirty\n');
  assert.equal(invoke('cleanRelease', { cwd: cleanRoot, tool_input: { command: 'npm publish' } }, { cwd: cleanRoot }).status, 2);

  const versionRoot = temporary(context, 'youdede-release-version-');
  writeFileSync(path.join(versionRoot, 'package.json'), '{"name":"toolkit","version":"1.2.3"}\n');
  writeFileSync(path.join(versionRoot, 'package-lock.json'), '{"name":"toolkit","version":"1.2.2","lockfileVersion":3,"packages":{"":{"version":"1.2.2"}}}\n');
  assert.equal(invoke('releaseVersion', { cwd: versionRoot, tool_input: { command: 'npm publish' } }, { cwd: versionRoot }).status, 2);
  assert.equal(invoke('releaseVersion', { cwd: versionRoot, tool_input: { command: 'npm publish --dry-run' } }, { cwd: versionRoot }).status, 0);

  const signatureRoot = repository(context, 'youdede-signature-intent-');
  git(signatureRoot, ['config', 'commit.gpgSign', 'false']);
  assert.equal(invoke('signature', { cwd: signatureRoot, tool_input: { command: 'git commit -m unsigned' } }, { cwd: signatureRoot }).status, 2);
  assert.equal(invoke('signature', { cwd: signatureRoot, tool_input: { command: 'git commit -S -m signed' } }, { cwd: signatureRoot }).status, 0);
});

test('Git gates normalize wrappers and reject commit-time auto-staging', (context) => {
  const root = repository(context, 'youdede-git-normalization-');
  writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/x":{"resolved":"http://example.invalid/x.tgz"}}}\n');
  git(root, ['add', 'package-lock.json']);
  for (const command of ['env MODE=safe /usr/bin/git commit -m test', "bash -lc 'git commit -m test'"]) {
    assert.equal(invoke('lockfile', { cwd: root, tool_input: { command } }, { cwd: root }).status, 2, command);
  }

  const autoStageRoot = repository(context, 'youdede-git-autostage-');
  writeFileSync(path.join(autoStageRoot, 'README.md'), 'unstaged change\n');
  for (const command of ['git commit -am update', 'env MODE=safe /usr/bin/git commit -am update', "bash -lc 'git commit -am update'"]) {
    for (const name of ['lockfile', 'symlink', 'executable']) {
      assert.equal(invoke(name, { cwd: autoStageRoot, tool_input: { command } }, { cwd: autoStageRoot }).status, 2, `${name}: ${command}`);
    }
    // largeDiff measures what -a can take against HEAD; one changed line is within the limits.
    assert.equal(invoke('largeDiff', { cwd: autoStageRoot, tool_input: { command } }, { cwd: autoStageRoot }).status, 0, `largeDiff: ${command}`);
  }
});

test('path portability checks every path component', (context) => {
  const root = temporary(context, 'youdede-portable-components-');
  mkdirSync(path.join(root, 'src'));
  const blocked = invoke('portability', { cwd: root, tool_name: 'Write', tool_input: { file_path: 'Src/new.js', content: '' } }, { cwd: root });
  assert.equal(blocked.status, 2, blocked.stderr);
});

test('large diff inspection accepts a staged binary deletion', (context) => {
  const root = repository(context, 'youdede-binary-delete-');
  writeFileSync(path.join(root, 'asset.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(root, ['add', 'asset.bin']);
  git(root, ['commit', '-qm', 'binary']);
  rmSync(path.join(root, 'asset.bin'));
  git(root, ['add', '-u', 'asset.bin']);
  const result = invoke('largeDiff', { cwd: root, tool_input: { command: 'git commit -m remove-binary' } }, { cwd: root });
  assert.equal(result.status, 0, result.stderr);
});

test('release metadata hooks normalize wrappers and fail closed on scoped publication', (context) => {
  const root = temporary(context, 'youdede-version-wrappers-');
  writeFileSync(path.join(root, 'package.json'), '{"name":"toolkit","version":"1.2.3"}\n');
  writeFileSync(path.join(root, 'package-lock.json'), '{"name":"toolkit","version":"1.2.2","lockfileVersion":3,"packages":{"":{"version":"1.2.2"}}}\n');
  for (const command of ['env MODE=safe /usr/bin/npm publish', "bash -lc 'npm publish'", 'npm --workspace package-a publish', 'npm publish ./release.tgz']) {
    assert.equal(invoke('releaseVersion', { cwd: root, tool_input: { command } }, { cwd: root }).status, 2, command);
  }
});
