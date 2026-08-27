import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  MAX_FILE_BYTES as CI_MAX_FILE_BYTES,
  MAX_STDIN_BYTES as CI_MAX_STDIN_BYTES,
  classifyCiPath,
  collectContext as collectCi,
  evaluate as evaluateCi,
  scanCiTrust
} from '../artifacts/hooks/security/supply-chain/ci-trust-boundary-guard/targets/claude-code/ci-trust-boundary-guard.mjs';
import {
  MAX_COMMAND_BYTES as TEST_MAX_COMMAND_BYTES,
  analyzeTestCommand,
  collectContext as collectTest,
  evaluate as evaluateTest,
  isTestSourcePath,
  scanTestIntegrity
} from '../artifacts/hooks/development/testing/test-integrity-guard/targets/claude-code/test-integrity-guard.mjs';

// The guards prefer CLAUDE_PROJECT_DIR over the payload cwd, so a value
// inherited from a Claude Code hook would redirect every fixture at the real
// repository. Clear it so the suite is hermetic wherever it runs.
delete process.env.CLAUDE_PROJECT_DIR;

const ROOT = path.resolve(import.meta.dirname, '..');
const CI_SCRIPT = path.join(ROOT, 'artifacts/hooks/security/supply-chain/ci-trust-boundary-guard/targets/claude-code/ci-trust-boundary-guard.mjs');
const TEST_SCRIPT = path.join(ROOT, 'artifacts/hooks/development/testing/test-integrity-guard/targets/claude-code/test-integrity-guard.mjs');

function temporary(context, prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('CI guard recognizes provider paths and high-confidence privilege expansions', () => {
  assert.equal(classifyCiPath('.github/workflows/ci.yml'), 'github-actions');
  assert.equal(classifyCiPath('.gitlab-ci.yml'), 'gitlab-ci');
  assert.equal(classifyCiPath('.circleci/config.yml'), 'circleci');
  assert.equal(classifyCiPath('.buildkite/pipeline.yml'), 'buildkite');
  assert.equal(classifyCiPath('azure-pipelines.yaml'), 'azure-pipelines');
  assert.equal(classifyCiPath('docs/workflow.yml'), null);
  assert.equal(classifyCiPath('fixture/.github/workflows/ci.yml'), null);

  assert.deepEqual(scanCiTrust('permissions: write-all\n', 'github-actions').map((item) => item.ruleId), ['ci-permissions-write-all']);
  assert.deepEqual(scanCiTrust('permissions: { contents: write }\n', 'github-actions').map((item) => item.ruleId), ['ci-permission-expanded']);
  assert.deepEqual(scanCiTrust('variables:\n  CI_DEBUG_TRACE: "true"\n', 'gitlab-ci').map((item) => item.ruleId), ['ci-secret-trace-enabled']);
  assert.deepEqual(scanCiTrust('jobs:\n  build:\n    docker:\n      - privileged: true\n', 'circleci').map((item) => item.ruleId), ['ci-privileged-executor']);
  assert.deepEqual(scanCiTrust('steps:\n  - plugins:\n      docker#v5:\n        volumes:\n          - /var/run/docker.sock:/var/run/docker.sock\n', 'buildkite').map((item) => item.ruleId), ['ci-host-runtime-socket']);
  assert.deepEqual(scanCiTrust('steps:\n- checkout: self\n  persistCredentials: true\n', 'azure-pipelines').map((item) => item.ruleId), ['ci-persisted-checkout-credentials']);
  assert.ok(scanCiTrust('"permissions":\n  "id-token": write\n', 'github-actions').some((item) => item.ruleId === 'ci-permission-expanded'));
  assert.ok(scanCiTrust('permissions: {\n  contents: write\n}\n', 'github-actions').some((item) => item.ruleId === 'ci-permission-expanded'));
  assert.ok(scanCiTrust('permissions: *release_permissions\n', 'github-actions').some((item) => item.ruleId === 'ci-permission-alias-uninspectable'));
  assert.ok(scanCiTrust('container: { image: build, privileged: true }\n', 'github-actions').some((item) => item.ruleId === 'ci-privileged-executor'));
  assert.ok(scanCiTrust('volumes:\n  - source: /var/run/docker.sock\n    target: /var/run/docker.sock\n', 'github-actions').some((item) => item.ruleId === 'ci-host-runtime-socket'));
});

test('CI guard detects untrusted checkout combined with secret or write authority', () => {
  const content = `on:\n  pull_request_target:\npermissions:\n  contents: write\njobs:\n  inspect:\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: deploy\n        env:\n          TOKEN: \${{ secrets.DEPLOY_TOKEN }}\n`;
  const rules = scanCiTrust(content, 'github-actions').map((item) => item.ruleId);
  assert.ok(rules.includes('ci-untrusted-trigger-secret-exposure'));
  assert.ok(rules.includes('ci-untrusted-trigger-write-authority'));
  assert.ok(rules.includes('ci-permission-expanded'));

  const bracketSecret = content.replace('secrets.DEPLOY_TOKEN', "secrets['DEPLOY_TOKEN']");
  assert.ok(scanCiTrust(bracketSecret, 'github-actions').some((item) => item.ruleId === 'ci-untrusted-trigger-secret-exposure'));
});

test('CI guard ignores comments, inert block examples, and safe read-only permissions', () => {
  const content = `# permissions: write-all\npermissions:\n  contents: read\njobs:\n  inspect:\n    steps:\n      - run: |\n          echo "privileged: true"\n          echo "/var/run/docker.sock:/var/run/docker.sock"\n`;
  assert.deepEqual(scanCiTrust(content, 'github-actions'), []);
});

test('CI guard blocks only net-new findings and safely reconstructs Edit', (context) => {
  const directory = temporary(context, 'youdede-ci-trust-');
  mkdirSync(path.join(directory, '.github', 'workflows'), { recursive: true });
  const target = path.join(directory, '.github', 'workflows', 'ci.yml');
  writeFileSync(target, 'permissions: write-all\njobs: {}\n');

  const unchangedLegacy = {
    cwd: directory,
    tool_input: { file_path: '.github/workflows/ci.yml', old_string: 'jobs: {}', new_string: 'jobs:\n  test: {}' }
  };
  assert.equal(evaluateCi(unchangedLegacy, collectCi(unchangedLegacy)).exitCode, 0);

  const added = {
    cwd: directory,
    tool_input: { file_path: '.github/workflows/ci.yml', old_string: 'jobs: {}', new_string: 'jobs: {}\nsecrets: inherit' }
  };
  assert.equal(evaluateCi(added, collectCi(added)).ruleId, 'ci-broad-secret-inheritance');

  const incomplete = {
    cwd: directory,
    tool_input: { file_path: '.github/workflows/ci.yml', old_string: 'not present', new_string: 'permissions: {}' }
  };
  assert.equal(evaluateCi(incomplete, collectCi(incomplete)).ruleId, 'ci-edit-inspection-incomplete');

  writeFileSync(target, 'permissions:\n  contents: write\n');
  const authoritySubstitution = {
    cwd: directory,
    tool_input: { file_path: '.github/workflows/ci.yml', old_string: 'contents: write', new_string: 'id-token: write' }
  };
  assert.equal(evaluateCi(authoritySubstitution, collectCi(authoritySubstitution)).ruleId, 'ci-permission-expanded');

  const multiEdit = { cwd: directory, tool_input: { file_path: '.github/workflows/ci.yml', edits: [] } };
  assert.equal(evaluateCi(multiEdit, collectCi(multiEdit)).ruleId, 'ci-edit-inspection-incomplete');
});

test('CI guard fails closed for symlinks, traversal, and oversized relevant content', (context) => {
  const directory = temporary(context, 'youdede-ci-trust-boundary-');
  mkdirSync(path.join(directory, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(directory, 'real.yml'), 'permissions: {}\n');
  symlinkSync(path.join(directory, 'real.yml'), path.join(directory, '.github', 'workflows', 'linked.yml'));

  const linked = { cwd: directory, tool_input: { file_path: '.github/workflows/linked.yml', content: 'permissions: {}\n' } };
  assert.equal(evaluateCi(linked, collectCi(linked)).ruleId, 'ci-file-inspection-failed');

  const traversal = { cwd: directory, tool_input: { file_path: '../.github/workflows/escape.yml', content: 'permissions: {}\n' } };
  assert.equal(evaluateCi(traversal, collectCi(traversal)).ruleId, 'ci-file-inspection-failed');

  const oversized = { cwd: directory, tool_input: { file_path: '.github/workflows/large.yml', content: ' '.repeat(CI_MAX_FILE_BYTES + 1) } };
  assert.equal(evaluateCi(oversized, collectCi(oversized)).ruleId, 'ci-input-too-large');

  const ancestorRoot = temporary(context, 'youdede-ci-ancestor-link-');
  const outside = temporary(context, 'youdede-ci-ancestor-outside-');
  mkdirSync(path.join(outside, 'workflows'));
  symlinkSync(outside, path.join(ancestorRoot, '.github'));
  const ancestorLink = { cwd: ancestorRoot, tool_input: { file_path: '.github/workflows/new.yml', content: 'permissions: {}\n' } };
  assert.equal(evaluateCi(ancestorLink, collectCi(ancestorLink)).ruleId, 'ci-file-inspection-failed');
});

test('test integrity scanner covers skip, xfail, and ignore without owning focus markers', () => {
  assert.equal(isTestSourcePath('src/widget.test.ts'), true);
  assert.equal(isTestSourcePath('tests/test_widget.py'), true);
  assert.equal(isTestSourcePath('docs/testing.md'), false);

  assert.deepEqual(scanTestIntegrity('src/widget.test.ts', 'test.skip("later", () => {});').map((item) => item.ruleId), ['test-skip-introduced']);
  assert.deepEqual(scanTestIntegrity('tests/test_widget.py', '@pytest.mark.xfail\ndef test_widget(): pass\n').map((item) => item.ruleId), ['test-xfail-introduced']);
  assert.deepEqual(scanTestIntegrity('tests/widget.rs', '#[ignore]\n#[test]\nfn widget() {}\n').map((item) => item.ruleId), ['test-ignore-introduced']);
  assert.deepEqual(scanTestIntegrity('tests/WidgetTest.java', '@Disabled\nclass WidgetTest {}\n').map((item) => item.ruleId), ['test-ignore-introduced']);
  assert.deepEqual(scanTestIntegrity('tests/WidgetTest.cs', '[Fact(Skip = "later")]\npublic void Widget() {}\n').map((item) => item.ruleId), ['test-skip-introduced']);
  assert.deepEqual(scanTestIntegrity('src/widget.test.ts', 'const result = `${test.skip("nested", () => {})}`;\n').map((item) => item.ruleId), ['test-skip-introduced']);
  assert.deepEqual(scanTestIntegrity('tests/test_widget.py', 'result = f"{pytest.skip(\'nested\')}"\n').map((item) => item.ruleId), ['test-skip-introduced']);

  assert.deepEqual(scanTestIntegrity('src/widget.test.ts', 'test.only("focused", () => {});\nfit("focused", () => {});\nfdescribe("focused", () => {});\n'), []);
  assert.deepEqual(scanTestIntegrity('src/widget.test.ts', '// test.skip("example", () => {});\nconst example = "test.skip(ignored)";\n'), []);
  assert.deepEqual(scanTestIntegrity('tests/test_widget.py', '# @pytest.mark.skip\nEXAMPLE = "pytest.skip()"\n'), []);
  assert.deepEqual(scanTestIntegrity('spec/widget_spec.rb', 'skip = false\n'), []);
  assert.deepEqual(scanTestIntegrity('tests/widget_test.go', 'logger.Skip()\n'), []);
});

test('test integrity guard allows existing suppressions and blocks newly added ones', (context) => {
  const directory = temporary(context, 'youdede-test-integrity-');
  mkdirSync(path.join(directory, 'tests'));
  writeFileSync(path.join(directory, 'tests', 'app.test.js'), 'test.skip("legacy", () => {});\ntest("active", () => {});\n');

  const ordinary = {
    cwd: directory,
    tool_input: { file_path: 'tests/app.test.js', old_string: 'test("active", () => {});', new_string: 'test("active", () => { expect(1).toBe(1); });' }
  };
  assert.equal(evaluateTest(ordinary, collectTest(ordinary)).exitCode, 0);

  const added = {
    cwd: directory,
    tool_input: { file_path: 'tests/app.test.js', old_string: 'test("active", () => {});', new_string: 'test.skip("active", () => {});' }
  };
  assert.equal(evaluateTest(added, collectTest(added)).ruleId, 'test-skip-introduced');

  const relocated = {
    cwd: directory,
    tool_input: {
      file_path: 'tests/app.test.js',
      old_string: 'test.skip("legacy", () => {});\ntest("active", () => {});',
      new_string: 'test("legacy", () => {});\ntest.skip("active", () => {});'
    }
  };
  assert.equal(evaluateTest(relocated, collectTest(relocated)).ruleId, 'test-skip-introduced');

  const incomplete = {
    cwd: directory,
    tool_input: { file_path: 'tests/app.test.js', old_string: 'not present', new_string: 'test("safe", () => {});' }
  };
  assert.equal(evaluateTest(incomplete, collectTest(incomplete)).ruleId, 'test-edit-inspection-incomplete');
  const multiEdit = { cwd: directory, tool_input: { file_path: 'tests/app.test.js', edits: [] } };
  assert.equal(evaluateTest(multiEdit, collectTest(multiEdit)).ruleId, 'test-edit-inspection-incomplete');
});

test('test integrity command policy blocks static deletion and rename-away but allows safe commands', () => {
  const blocked = [
    ['rm tests/app.test.js', 'test-file-delete'],
    ['rm -rf tests', 'test-file-delete'],
    ['git rm --cached src/widget.test.ts', 'test-file-delete'],
    ['git -c core.quotePath=false rm tests/app.test.js', 'test-file-delete'],
    ['unlink spec/widget_spec.rb', 'test-file-delete'],
    ['find tests -name "*.js" -delete', 'test-file-delete'],
    ['mv src/widget.test.ts src/widget.ts', 'test-file-rename-away'],
    ['mv tests archive', 'test-file-rename-away'],
    ['mv -t archive tests', 'test-file-rename-away'],
    ['git mv tests/test_widget.py archive/widget.py', 'test-file-rename-away'],
    ["bash -lc 'rm tests/app.test.js'", 'test-file-delete']
    ,['find . -delete', 'test-file-delete']
    ,['rm -rf .', 'test-file-delete']
  ];
  for (const [command, ruleId] of blocked) assert.equal(analyzeTestCommand(command).finding?.ruleId, ruleId, command);

  const allowed = [
    'rm tmp/output.txt',
    'mv src/widget.test.ts tests/widget.test.ts',
    'git mv tests/test_widget.py tests/test_service.py',
    'echo "rm tests/app.test.js"',
    'git status tests/app.test.js',
    'npm test',
    'node --test tests/app.test.js'
  ];
  for (const command of allowed) assert.equal(analyzeTestCommand(command).finding, null, command);

  const oversized = 'x'.repeat(TEST_MAX_COMMAND_BYTES + 1);
  assert.equal(analyzeTestCommand(oversized).finding?.ruleId, 'test-command-too-large');
});

test('test integrity guard fails closed for symlinked relevant edits', (context) => {
  const directory = temporary(context, 'youdede-test-integrity-link-');
  mkdirSync(path.join(directory, 'tests'));
  writeFileSync(path.join(directory, 'source.test.js'), 'test("safe", () => {});\n');
  symlinkSync(path.join(directory, 'source.test.js'), path.join(directory, 'tests', 'linked.test.js'));
  const input = { cwd: directory, tool_input: { file_path: 'tests/linked.test.js', content: 'test("safe", () => {});\n' } };
  assert.equal(evaluateTest(input, collectTest(input)).ruleId, 'test-file-inspection-failed');

  const ancestorRoot = temporary(context, 'youdede-test-ancestor-link-');
  const outside = temporary(context, 'youdede-test-ancestor-outside-');
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, path.join(ancestorRoot, 'tests'));
  const ancestorLink = { cwd: ancestorRoot, tool_input: { file_path: 'tests/new.test.js', content: 'test("safe", () => {});\n' } };
  assert.equal(evaluateTest(ancestorLink, collectTest(ancestorLink)).ruleId, 'test-file-inspection-failed');
});

test('both hook wrappers fail closed on malformed and oversized input and expose stable process exits', () => {
  for (const [name, script] of [['ci', CI_SCRIPT], ['test', TEST_SCRIPT]]) {
    const malformed = spawnSync(process.execPath, [script], { input: '{bad', encoding: 'utf8' });
    assert.equal(malformed.status, 2, name);
    assert.match(malformed.stderr, /input-invalid/, name);

    const oversized = spawnSync(process.execPath, [script], { input: 'x'.repeat(CI_MAX_STDIN_BYTES + 1), encoding: 'utf8' });
    assert.equal(oversized.status, 2, name);
    assert.match(oversized.stderr, /exceeds/, name);
  }

  const ciBlocked = spawnSync(process.execPath, [CI_SCRIPT], {
    input: JSON.stringify({ tool_input: { file_path: '.github/workflows/ci.yml', content: 'permissions: write-all\n' } }),
    encoding: 'utf8'
  });
  assert.equal(ciBlocked.status, 2);
  assert.match(ciBlocked.stderr, /ci-permissions-write-all/);

  const testBlocked = spawnSync(process.execPath, [TEST_SCRIPT], {
    input: JSON.stringify({ tool_input: { file_path: 'tests/app.test.js', content: 'test.skip("later", () => {});\n' } }),
    encoding: 'utf8'
  });
  assert.equal(testBlocked.status, 2);
  assert.match(testBlocked.stderr, /test-skip-introduced/);

  const allowed = spawnSync(process.execPath, [TEST_SCRIPT], {
    input: JSON.stringify({ tool_input: { command: 'npm test' } }),
    encoding: 'utf8'
  });
  assert.equal(allowed.status, 0, allowed.stderr);
});
