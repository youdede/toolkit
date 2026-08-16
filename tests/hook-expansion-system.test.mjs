import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CASES = [
  {
    slug: 'archive-extraction-guard',
    source: 'artifacts/hooks/security/archive-extraction/archive-extraction-guard/targets/claude-code/archive-extraction-guard.mjs',
    allow: { tool_name: 'Bash', tool_input: { command: 'tar -tf release.tar' } },
    block: { tool_name: 'Bash', tool_input: { command: 'tar -xf release.tar' } },
    falsePositive: { tool_name: 'Bash', tool_input: { command: "echo 'tar -xf release.tar'" } },
    oversize: (limit) => ({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(limit + 1) } })
  },
  {
    slug: 'transport-security-regression-guard',
    source: 'artifacts/hooks/security/transport-security/transport-security-regression-guard/targets/claude-code/transport-security-regression-guard.mjs',
    allow: { tool_name: 'Write', tool_input: { file_path: 'src/client.js', content: 'const secure = true;\n' } },
    block: { tool_name: 'Write', tool_input: { file_path: 'src/client.js', content: 'const agent = { rejectUnauthorized: false };\n' } },
    falsePositive: { tool_name: 'Write', tool_input: { file_path: 'src/client.js', content: '// rejectUnauthorized: false is forbidden\nconst secure = true;\n' } },
    oversize: (limit) => ({ tool_name: 'Write', tool_input: { file_path: 'src/client.js', content: 'x'.repeat(limit + 1) } }),
    limit: 'MAX_CONTENT_BYTES'
  },
  {
    slug: 'dynamic-code-execution-guard',
    source: 'artifacts/hooks/security/code-execution/dynamic-code-execution-guard/targets/claude-code/dynamic-code-execution-guard.mjs',
    allow: { tool_name: 'Write', tool_input: { file_path: 'src/app.js', content: 'JSON.parse(payload);\n' } },
    block: { tool_name: 'Write', tool_input: { file_path: 'src/app.js', content: 'eval(payload);\n' } },
    falsePositive: { tool_name: 'Write', tool_input: { file_path: 'src/app.js', content: '// eval(payload) is forbidden\nconst label = "eval(payload)";\n' } },
    oversize: (limit) => ({ tool_name: 'Write', tool_input: { file_path: 'src/app.js', content: 'x'.repeat(limit + 1) } }),
    limit: 'MAX_CONTENT_BYTES'
  },
  {
    slug: 'container-privilege-guard',
    source: 'artifacts/hooks/security/container-runtime/container-privilege-guard/targets/claude-code/container-privilege-guard.mjs',
    allow: { tool_name: 'Bash', tool_input: { command: 'docker run --read-only alpine' } },
    block: { tool_name: 'Bash', tool_input: { command: 'docker run --privileged alpine' } },
    falsePositive: { tool_name: 'Bash', tool_input: { command: "echo 'docker run --privileged alpine'" } },
    oversize: (limit) => ({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(limit + 1) } })
  },
  {
    slug: 'infrastructure-apply-guard',
    source: 'artifacts/hooks/operations/infrastructure-execution/infrastructure-apply-guard/targets/claude-code/infrastructure-apply-guard.mjs',
    allow: { tool_name: 'Bash', tool_input: { command: 'terraform plan' } },
    block: { tool_name: 'Bash', tool_input: { command: 'terraform apply saved.plan' } },
    falsePositive: { tool_name: 'Bash', tool_input: { command: "printf '%s' 'terraform apply'" } },
    oversize: (limit) => ({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(limit + 1) } })
  },
  {
    slug: 'cloud-resource-deletion-guard',
    source: 'artifacts/hooks/operations/cloud-resources/cloud-resource-deletion-guard/targets/claude-code/cloud-resource-deletion-guard.mjs',
    allow: { tool_name: 'Bash', tool_input: { command: 'aws ec2 describe-instances' } },
    block: { tool_name: 'Bash', tool_input: { command: 'aws ec2 terminate-instances --instance-ids i-static' } },
    falsePositive: { tool_name: 'Bash', tool_input: { command: "echo 'aws ec2 terminate-instances'" } },
    oversize: (limit) => ({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(limit + 1) } })
  },
  {
    slug: 'system-path-mutation-guard',
    source: 'artifacts/hooks/security/host-filesystem/system-path-mutation-guard/targets/claude-code/system-path-mutation-guard.mjs',
    allow: { tool_name: 'Bash', tool_input: { command: 'cp /etc/hosts ./hosts-copy' } },
    block: { tool_name: 'Bash', tool_input: { command: 'cp config.ini /etc/tool/config.ini' } },
    falsePositive: { tool_name: 'Bash', tool_input: { command: "echo 'cp config.ini /etc/tool/config.ini'" } },
    oversize: (limit) => ({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(limit + 1) } })
  },
  {
    slug: 'system-service-mutation-guard',
    source: 'artifacts/hooks/operations/system-services/system-service-mutation-guard/targets/claude-code/system-service-mutation-guard.mjs',
    allow: { tool_name: 'Bash', tool_input: { command: 'systemctl status api.service' } },
    block: { tool_name: 'Bash', tool_input: { command: 'systemctl restart api.service' } },
    falsePositive: { tool_name: 'Bash', tool_input: { command: "echo 'systemctl restart api.service'" } },
    oversize: (limit) => ({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(limit + 1) } })
  },
  {
    slug: 'scheduled-task-mutation-guard',
    source: 'artifacts/hooks/operations/scheduled-execution/scheduled-task-mutation-guard/targets/claude-code/scheduled-task-mutation-guard.mjs',
    allow: { tool_name: 'Bash', tool_input: { command: 'crontab -l' } },
    block: { tool_name: 'Bash', tool_input: { command: 'crontab schedule.txt' } },
    falsePositive: { tool_name: 'Bash', tool_input: { command: "echo 'crontab schedule.txt'" } },
    oversize: (limit) => ({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(limit + 1) } })
  },
  {
    slug: 'firewall-policy-mutation-guard',
    source: 'artifacts/hooks/security/network-control/firewall-policy-mutation-guard/targets/claude-code/firewall-policy-mutation-guard.mjs',
    allow: { tool_name: 'Bash', tool_input: { command: 'iptables -L -n' } },
    block: { tool_name: 'Bash', tool_input: { command: 'iptables -F' } },
    falsePositive: { tool_name: 'Bash', tool_input: { command: "echo 'iptables -F'" } },
    oversize: (limit) => ({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(limit + 1) } })
  },
  {
    slug: 'user-account-mutation-guard',
    source: 'artifacts/hooks/security/identity-administration/user-account-mutation-guard/targets/claude-code/user-account-mutation-guard.mjs',
    allow: { tool_name: 'Bash', tool_input: { command: 'id example-user' } },
    block: { tool_name: 'Bash', tool_input: { command: 'useradd example-user' } },
    falsePositive: { tool_name: 'Bash', tool_input: { command: "echo 'useradd example-user'" } },
    oversize: (limit) => ({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(limit + 1) } })
  },
  {
    slug: 'package-publish-guard',
    source: 'artifacts/hooks/operations/package-publication/package-publish-guard/targets/claude-code/package-publish-guard.mjs',
    allow: { tool_name: 'Bash', tool_input: { command: 'npm pack' } },
    block: { tool_name: 'Bash', tool_input: { command: 'npm publish' } },
    falsePositive: { tool_name: 'Bash', tool_input: { command: "echo 'npm publish'" } },
    oversize: (limit) => ({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(limit + 1) } })
  },
  {
    slug: 'container-registry-publish-guard',
    source: 'artifacts/hooks/operations/image-publication/container-registry-publish-guard/targets/claude-code/container-registry-publish-guard.mjs',
    allow: { tool_name: 'Bash', tool_input: { command: 'docker build -t local/test .' } },
    block: { tool_name: 'Bash', tool_input: { command: 'docker push registry.example/test:1' } },
    falsePositive: { tool_name: 'Bash', tool_input: { command: "echo 'docker push registry.example/test:1'" } },
    oversize: (limit) => ({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(limit + 1) } })
  }
];

assert.equal(CASES.length, 13);

for (const definition of CASES) {
  test(`${definition.slug} has bounded pure policy and process behavior`, async () => {
    const absolute = path.join(ROOT, definition.source);
    const implementation = await import(pathToFileURL(absolute));
    const limit = implementation[definition.limit || 'MAX_COMMAND_BYTES'];

    assert.equal(typeof implementation.evaluate, 'function');
    assert.equal(implementation.evaluate(definition.allow).exitCode, 0, 'allow boundary');
    assert.equal(implementation.evaluate(definition.falsePositive).exitCode, 0, 'false-positive boundary');
    const blocked = implementation.evaluate(definition.block);
    assert.equal(blocked.exitCode, 2, 'block boundary');
    assert.match(blocked.ruleId, /^[a-z0-9-]+$/);
    assert.equal(implementation.evaluate(null).exitCode, 2, 'malformed boundary');
    assert.equal(implementation.evaluate(definition.oversize(limit)).exitCode, 2, 'oversized policy boundary');

    const blockedProcess = spawnSync(process.execPath, [absolute], { input: JSON.stringify(definition.block), encoding: 'utf8' });
    assert.equal(blockedProcess.status, 2, blockedProcess.stderr);
    assert.match(blockedProcess.stderr, new RegExp(definition.slug));

    const malformedProcess = spawnSync(process.execPath, [absolute], { input: '{malformed-sentinel', encoding: 'utf8' });
    assert.equal(malformedProcess.status, 2);
    assert.doesNotMatch(malformedProcess.stderr, /malformed-sentinel/);

    const oversizedProcess = spawnSync(process.execPath, [absolute], {
      input: 'x'.repeat(implementation.MAX_STDIN_BYTES + 1), encoding: 'utf8', maxBuffer: implementation.MAX_STDIN_BYTES * 2
    });
    assert.equal(oversizedProcess.status, 2);
  });
}

test('the thirteen hook packages have executable adapters and documented refusals', () => {
  for (const definition of CASES) {
    const source = path.join(ROOT, definition.source);
    const artifactDirectory = path.resolve(path.dirname(source), '..', '..');
    const manifestPath = path.join(artifactDirectory, 'artifact.json');
    const adapterPath = path.join(artifactDirectory, 'adapters', 'claude-code.json');
    const readmePath = path.join(path.dirname(source), 'README.md');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const adapter = JSON.parse(readFileSync(adapterPath, 'utf8'));
    const readme = readFileSync(readmePath, 'utf8');

    assert.equal(manifest.slug, definition.slug);
    assert.equal(manifest.execution.mode, 'deterministic');
    assert.ok(manifest.refuses.length >= 3);
    assert.equal(adapter.scopes.join(','), 'project');
    assert.equal(adapter.files[0].executable, true);
    assert.ok((statSync(source).mode & 0o111) !== 0);
    assert.ok((readme.match(/^[-*] /gm) || []).length >= 3);
    assert.match(readme, /Refusals and limits/);
  }
});

test('command hooks normalize absolute tools, env wrappers, and static shell commands', async () => {
  for (const definition of CASES.filter((entry) => entry.block.tool_name === 'Bash')) {
    const implementation = await import(pathToFileURL(path.join(ROOT, definition.source)));
    const command = definition.block.tool_input.command;
    const [executable, ...rest] = command.split(' ');
    for (const variant of [
      `/usr/bin/${executable} ${rest.join(' ')}`,
      `env HOOK_TEST=1 ${command}`,
      `bash -lc '${command}'`
    ]) assert.equal(implementation.evaluate({ tool_name: 'Bash', tool_input: { command: variant } }).exitCode, 2, `${definition.slug}: ${variant}`);
  }
});

test('global options and dry runs preserve command intent boundaries', async () => {
  const container = await import(pathToFileURL(path.join(ROOT, CASES.find((entry) => entry.slug === 'container-privilege-guard').source)));
  const publish = await import(pathToFileURL(path.join(ROOT, CASES.find((entry) => entry.slug === 'package-publish-guard').source)));
  const registry = await import(pathToFileURL(path.join(ROOT, CASES.find((entry) => entry.slug === 'container-registry-publish-guard').source)));
  assert.equal(container.evaluate({ tool_name: 'Bash', tool_input: { command: 'docker --config /tmp/config run --privileged alpine' } }).exitCode, 2);
  assert.equal(publish.evaluate({ tool_name: 'Bash', tool_input: { command: 'npm --workspace package-a publish' } }).exitCode, 2);
  assert.equal(registry.evaluate({ tool_name: 'Bash', tool_input: { command: 'docker --config /tmp/config push registry.invalid/a:1' } }).exitCode, 2);
  assert.equal(publish.evaluate({ tool_name: 'Bash', tool_input: { command: 'npm publish --dry-run' } }).exitCode, 0);
  assert.equal(publish.evaluate({ tool_name: 'Bash', tool_input: { command: 'poetry publish --dry-run' } }).exitCode, 0);
});

test('scheduled execution distinguishes read-only queries from scheduler mutations', async () => {
  const scheduled = await import(pathToFileURL(path.join(ROOT, CASES.find((entry) => entry.slug === 'scheduled-task-mutation-guard').source)));
  for (const command of ['crontab -u build-user -l', 'atq', 'launchctl print gui/501']) {
    assert.equal(scheduled.evaluate({ tool_name: 'Bash', tool_input: { command } }).exitCode, 0, command);
  }
  for (const command of [
    'systemd-run --on-calendar=daily backup.service',
    'launchctl enable gui/501/com.example.job',
    'pmset repeat wakeorpoweron MTWRF 09:00:00'
  ]) assert.equal(scheduled.evaluate({ tool_name: 'Bash', tool_input: { command } }).exitCode, 2, command);
});

test('hybrid hooks reconstruct Edit and MultiEdit and ignore inert strings', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-system-hooks-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const cases = [
    ['transport-security-regression-guard', 'src/client.js', 'const client = { rejectUnauthorized: true };\n', { tool_name: 'Edit', tool_input: { file_path: 'src/client.js', old_string: 'true', new_string: 'false' } }],
    ['dynamic-code-execution-guard', 'src/app.js', 'const parse = (value) => JSON.parse(value);\n', { tool_name: 'MultiEdit', tool_input: { file_path: 'src/app.js', edits: [{ old_string: 'JSON.parse(value)', new_string: 'eval(value)' }] } }],
    ['container-privilege-guard', 'compose.yml', 'services:\n  app:\n    privileged: false\n', { tool_name: 'Edit', tool_input: { file_path: 'compose.yml', old_string: 'privileged: false', new_string: 'privileged: true' } }]
  ];
  for (const [slug, file, content, input] of cases) {
    const absolute = path.join(directory, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    const definition = CASES.find((entry) => entry.slug === slug);
    const result = spawnSync(process.execPath, [path.join(ROOT, definition.source)], { cwd: directory, input: JSON.stringify({ cwd: directory, ...input }), encoding: 'utf8' });
    assert.equal(result.status, 2, `${slug}: ${result.stderr}`);
  }
});

test('hybrid scanners distinguish executable syntax from documentation strings', async () => {
  const transport = await import(pathToFileURL(path.join(ROOT, CASES.find((entry) => entry.slug === 'transport-security-regression-guard').source)));
  const dynamic = await import(pathToFileURL(path.join(ROOT, CASES.find((entry) => entry.slug === 'dynamic-code-execution-guard').source)));
  const container = await import(pathToFileURL(path.join(ROOT, CASES.find((entry) => entry.slug === 'container-privilege-guard').source)));
  assert.equal(transport.evaluate({ tool_name: 'Write', tool_input: { file_path: 'src/x.js', content: 'const note = "registry: \'http://unsafe.invalid\'";\n' } }).exitCode, 0);
  assert.equal(dynamic.evaluate({ tool_name: 'Write', tool_input: { file_path: 'src/x.js', content: 'class Parser { #eval(value) { return value; } run(v) { return this.#eval(v); } }\n' } }).exitCode, 0);
  assert.equal(dynamic.evaluate({ tool_name: 'Write', tool_input: { file_path: 'src/x.js', content: 'const value = `${eval(payload)}`;\n' } }).exitCode, 2);
  assert.equal(container.evaluate({ tool_name: 'Write', tool_input: { file_path: 'compose.yml', content: 'services:\n  app:\n    command: "privileged: true"\n' } }).exitCode, 0);
});
