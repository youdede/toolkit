import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { loadPacks, validateRepository } from '../scripts/lib/catalog.mjs';
import { doctor, installPack, removePack } from '../scripts/lib/install.mjs';
import { validatePackEvaluations } from '../scripts/validate-pack-evaluations.mjs';
import { verifyPackEvidence } from '../scripts/verify-pack-evidence.mjs';

function reportFor(pack) {
  return {
    $schema: 'https://youdede.dev/schemas/pack-evidence-v1.json',
    schemaVersion: 1,
    packId: pack.id,
    packVersion: pack.version,
    generatedAt: '2026-09-21T12:00:00.000Z',
    ledgerEntryHash: 'a'.repeat(64),
    outcomes: pack.evidence.outcomeEvidence.map((mapping) => ({
      outcome: mapping.outcome,
      status: 'verified',
      evidence: mapping.memberArtifactIds.map((artifactId) => ({ artifactId, evidenceHash: 'b'.repeat(64), claim: `Verified evidence from ${artifactId}.` }))
    }))
  };
}

test('every pack has a versioned ledger-linked evidence contract and behavioral evaluation', () => {
  const repository = validateRepository();
  assert.equal(repository.packs.length, 13);
  assert.deepEqual(repository.packResults.flatMap(({ errors }) => errors), []);
  assert.deepEqual(validatePackEvaluations(), []);
  for (const { manifest } of loadPacks()) {
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
    assert.equal(manifest.evidence.ledgerLinkRequired, true);
    assert.deepEqual(new Set(manifest.evidence.outcomeEvidence.map(({ outcome }) => outcome)), new Set(manifest.outcomes));
    assert.deepEqual(verifyPackEvidence(manifest, reportFor(manifest)), []);
  }
});

test('pack evidence refuses missing members, ledger mismatch, and undeclared sources', () => {
  const pack = loadPacks().find(({ manifest }) => manifest.id === 'pack/mcp-baseline').manifest;
  const missing = reportFor(pack);
  missing.outcomes[0].evidence.pop();
  assert.ok(verifyPackEvidence(pack, missing).some((failure) => /omits declared member/.test(failure)));

  const ledger = reportFor(pack);
  ledger.ledgerEntryHash = 'not-a-hash';
  assert.ok(verifyPackEvidence(pack, ledger).some((failure) => /ledgerEntryHash/.test(failure)));

  const undeclared = reportFor(pack);
  undeclared.outcomes[0].evidence[0].artifactId = 'skill/development/testing/deliver-test-first';
  assert.ok(verifyPackEvidence(pack, undeclared).some((failure) => /undeclared member/.test(failure)));

  const duplicate = reportFor(pack);
  duplicate.outcomes[0].evidence.push(structuredClone(duplicate.outcomes[0].evidence[0]));
  assert.ok(verifyPackEvidence(pack, duplicate).some((failure) => /repeats member evidence/.test(failure)));

  const extra = reportFor(pack);
  extra.unbounded = true;
  assert.ok(verifyPackEvidence(pack, extra).some((failure) => /unexpected or missing property/.test(failure)));
});

test('pack evidence CLI accepts bounded reports and fails closed on symbolic links', (context) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'youdede-pack-evidence-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const pack = loadPacks().find(({ manifest }) => manifest.id === 'pack/daily-driver').manifest;
  const report = path.join(directory, 'report.json');
  writeFileSync(report, JSON.stringify(reportFor(pack)));
  const valid = spawnSync(process.execPath, ['scripts/verify-pack-evidence.mjs', '--pack', pack.slug, '--report', report], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).ok, true);

  const publicCli = spawnSync(process.execPath, ['bin/youdede-toolkit.mjs', 'verify-pack-evidence', pack.slug, '--report', report, '--json'], { encoding: 'utf8' });
  assert.equal(publicCli.status, 0, publicCli.stderr);
  assert.equal(JSON.parse(publicCli.stdout).packVersion, pack.version);

  if (process.platform !== 'win32') {
    const link = path.join(directory, 'linked.json');
    const linked = spawnSync('ln', ['-s', report, link], { encoding: 'utf8' });
    assert.equal(linked.status, 0, linked.stderr);
    const refused = spawnSync(process.execPath, ['scripts/verify-pack-evidence.mjs', '--pack', pack.slug, '--report', link], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /non-symlink/);
  }
});

test('new workflow packs install and remove as atomic Claude Code compositions', (context) => {
  for (const slug of ['daily-driver', 'mcp-baseline', 'plan-and-verify-loop', 'session-continuity']) {
    const directory = mkdtempSync(path.join(os.tmpdir(), `youdede-${slug}-`));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const installed = installPack(slug, { cwd: directory });
    assert.equal(installed.installed.length, installed.pack.members.length);
    assert.deepEqual(doctor({ cwd: directory }).findings, []);
    removePack(slug, { cwd: directory });
    assert.equal(doctor({ cwd: directory }).installs, 0);
    assert.equal(existsSync(path.join(directory, '.mcp.json')), false);
  }
});
