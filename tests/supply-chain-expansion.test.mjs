import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectSupplyChainSignals,
  MAX_FILE_BYTES,
  MAX_FILE_COUNT
} from '../artifacts/skills/security/supply-chain/review-supply-chain-change/scripts/collect-supply-chain-signals.mjs';

const SCRIPT = path.resolve('artifacts/skills/security/supply-chain/review-supply-chain-change/scripts/collect-supply-chain-signals.mjs');

test('supply-chain collector reports only bounded observable npm manifest signals', () => {
  const result = collectSupplyChainSignals([{
    path: 'package.json',
    content: JSON.stringify({
      packageManager: 'npm@11.0.0',
      scripts: { postinstall: 'node setup.mjs', test: 'node --test' },
      dependencies: {
        registry: '^1.0.0',
        archive: 'https://packages.example.invalid/archive.tgz',
        insecure: 'http://packages.example.invalid/archive.tgz',
        checkout: 'git+https://example.invalid/repository.git#abc',
        local: 'file:../local-package'
      }
    })
  }]);

  const signals = result.files[0].signals;
  assert.equal(result.collector, 'offline-supply-chain-signals');
  assert.ok(signals.some((signal) => signal.ruleId === 'SC_INSTALL_LIFECYCLE_SCRIPT' && signal.name === 'postinstall'));
  assert.deepEqual(
    signals.filter((signal) => signal.ruleId === 'SC_DEPENDENCY_SOURCE').map((signal) => signal.sourceType).sort(),
    ['git', 'local-path', 'remote-archive', 'unencrypted-remote']
  );
  assert.ok(!JSON.stringify(result).includes('node setup.mjs'));
  assert.ok(!signals.some((signal) => signal.name === 'registry'));
});

test('supply-chain collector classifies workflow refs without parsing or executing YAML', () => {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const result = collectSupplyChainSignals([{
    path: '.github/workflows/release.yml',
    content: `steps:\n  - uses: actions/checkout@${commit}\n  - uses: vendor/action@v2\n  - uses: ./.github/actions/local\n  - uses: vendor/action@\${{ inputs.ref }}\n`
  }]);
  assert.deepEqual(
    result.files[0].signals.map((signal) => signal.referenceType),
    ['full-commit', 'named-ref', 'local-path', 'dynamic-expression']
  );
  assert.deepEqual(result.files[0].signals.map((signal) => signal.line), [2, 3, 4, 5]);
});

test('supply-chain collector reports npm lockfile properties without echoing resolved URLs', () => {
  const result = collectSupplyChainSignals([{
    path: 'package-lock.json',
    content: JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/a': { resolved: 'https://user:token@example.invalid/a.tgz', hasInstallScript: true },
        'node_modules/b': { resolved: 'http://example.invalid/b.tgz', integrity: 'sha512-example' }
      }
    })
  }]);
  const serialized = JSON.stringify(result);
  assert.ok(result.files[0].signals.some((signal) => signal.ruleId === 'SC_REMOTE_LOCK_ENTRY_WITHOUT_INTEGRITY'));
  assert.ok(result.files[0].signals.some((signal) => signal.ruleId === 'SC_LOCK_INSTALL_SCRIPT'));
  assert.ok(result.files[0].signals.some((signal) => signal.sourceType === 'unencrypted-remote'));
  assert.ok(!serialized.includes('user:token'));
  assert.ok(!serialized.includes('example.invalid'));
});

test('supply-chain collector rejects malformed, duplicate, unsupported, and oversized evidence', () => {
  assert.throws(() => collectSupplyChainSignals([{ path: 'package.json', content: '{' }]), /not valid object JSON/);
  assert.throws(() => collectSupplyChainSignals([
    { path: 'package.json', content: '{}' },
    { path: './package.json', content: '{}' }
  ]), /duplicate evidence file/);
  assert.throws(() => collectSupplyChainSignals([{ path: 'src/index.js', content: '' }]), /unsupported/);
  assert.throws(() => collectSupplyChainSignals([{ path: 'package.json', content: 'x'.repeat(MAX_FILE_BYTES + 1) }]), /exceeds/);
  const tooMany = Array.from({ length: MAX_FILE_COUNT + 1 }, (_, index) => ({ path: `workspace-${index}/package.json`, content: '{}' }));
  assert.throws(() => collectSupplyChainSignals(tooMany), /file count exceeds/);
});

test('supply-chain CLI reads only explicit in-root non-symlink files', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'supply-chain-signals-'));
  try {
    writeFileSync(path.join(directory, 'package.json'), '{"dependencies":{"safe":"^1.0.0"}}\n');
    symlinkSync(path.join(directory, 'package.json'), path.join(directory, 'linked-package.json'));

    const success = spawnSync(process.execPath, [SCRIPT, '--root', directory, '--file', 'package.json'], { encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).totals.files, 1);

    const symlink = spawnSync(process.execPath, [SCRIPT, '--root', directory, '--file', 'linked-package.json'], { encoding: 'utf8' });
    assert.notEqual(symlink.status, 0);
    assert.match(symlink.stderr, /symlink evidence paths are not allowed/);

    const traversal = spawnSync(process.execPath, [SCRIPT, '--root', directory, '--file', '../package.json'], { encoding: 'utf8' });
    assert.notEqual(traversal.status, 0);
    assert.match(traversal.stderr, /must stay inside the root/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
