// SPDX-License-Identifier: MIT
// Copyright (c) 2026 youdede contributors

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const INTEGRITY_SCHEMA_VERSION = 1;
export const INTEGRITY_ALGORITHM = 'sha256';
export const INTEGRITY_DOMAIN = 'youdede-artifact-attestation-v1';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function portable(relative) {
  return relative.split(path.sep).join('/');
}

function walkFiles(root, current = root, output = []) {
  const metadata = lstatSync(current);
  if (metadata.isSymbolicLink()) throw new Error(`integrity input contains symbolic link '${portable(path.relative(root, current) || '.')}'`);
  if (metadata.isFile()) {
    output.push(current);
    return output;
  }
  if (!metadata.isDirectory()) throw new Error(`integrity input contains unsupported file '${portable(path.relative(root, current) || '.')}'`);
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    walkFiles(root, path.join(current, entry.name), output);
  }
  return output;
}

function payloadPaths(record) {
  const root = record.root;
  const absolute = new Set(walkFiles(record.directory));
  for (const adapter of Object.values(record.adapters)) {
    for (const mapping of adapter.data.files || []) {
      if (mapping.root !== 'package') continue;
      const source = path.resolve(root, mapping.from);
      if (!existsSync(source)) throw new Error(`${record.manifest.id}: package payload '${mapping.from}' is missing`);
      for (const file of walkFiles(source)) absolute.add(file);
    }
  }
  return [...absolute].sort((left, right) => portable(path.relative(root, left)).localeCompare(portable(path.relative(root, right))));
}

function fileRecords(record) {
  return payloadPaths(record).map((file) => {
    const data = readFileSync(file);
    return {
      path: portable(path.relative(record.root, file)),
      bytes: data.length,
      sha256: sha256(data)
    };
  });
}

function attestedContent(record) {
  return {
    domain: INTEGRITY_DOMAIN,
    artifactId: record.manifest.id,
    version: record.manifest.version,
    license: record.manifest.license,
    authors: [...record.manifest.authors],
    files: fileRecords(record)
  };
}

export function buildArtifactAttestation(record) {
  const content = attestedContent(record);
  const digest = sha256(Buffer.from(JSON.stringify(content)));
  return {
    artifactId: content.artifactId,
    version: content.version,
    integrityId: `urn:youdede:artifact:${INTEGRITY_ALGORITHM}:${digest}`,
    digest,
    license: content.license,
    authors: content.authors,
    files: content.files
  };
}

export function buildIntegrityManifest(records) {
  const artifacts = [...records]
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
    .map(buildArtifactAttestation);
  const rootContent = {
    domain: 'youdede-integrity-catalog-v1',
    schemaVersion: INTEGRITY_SCHEMA_VERSION,
    algorithm: INTEGRITY_ALGORITHM,
    artifacts
  };
  return {
    schemaVersion: INTEGRITY_SCHEMA_VERSION,
    algorithm: INTEGRITY_ALGORITHM,
    claim: 'Checksums bind published bytes to a reviewed release; they do not prove authorship, originality, license compliance, endorsement, or control downstream copying.',
    rootDigest: sha256(Buffer.from(JSON.stringify(rootContent))),
    artifacts
  };
}

function manifestRootDigest(manifest) {
  return sha256(Buffer.from(JSON.stringify({
    domain: 'youdede-integrity-catalog-v1',
    schemaVersion: manifest.schemaVersion,
    algorithm: manifest.algorithm,
    artifacts: manifest.artifacts
  })));
}

export function readIntegrityManifest(root) {
  const file = path.join(root, 'catalog', 'integrity.json');
  if (!existsSync(file)) throw new Error(`integrity catalog is missing at ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`integrity catalog is invalid JSON: ${error.message}`);
  }
  if (parsed?.schemaVersion !== INTEGRITY_SCHEMA_VERSION || parsed?.algorithm !== INTEGRITY_ALGORITHM || !Array.isArray(parsed?.artifacts)) {
    throw new Error('integrity catalog has an unsupported format');
  }
  if (!/^[a-f0-9]{64}$/.test(parsed.rootDigest || '') || manifestRootDigest(parsed) !== parsed.rootDigest) {
    throw new Error('integrity catalog root digest does not match its attestation set');
  }
  const ids = parsed.artifacts.map(({ artifactId }) => artifactId);
  if (new Set(ids).size !== ids.length) throw new Error('integrity catalog contains duplicate artifact ids');
  return parsed;
}

function difference(expected, actual) {
  const expectedFiles = new Map(expected.files.map((file) => [file.path, file]));
  const actualFiles = new Map(actual.files.map((file) => [file.path, file]));
  const findings = [];
  for (const [file, expectedFile] of expectedFiles) {
    const actualFile = actualFiles.get(file);
    if (!actualFile) findings.push({ artifactId: expected.artifactId, path: file, status: 'missing' });
    else if (expectedFile.sha256 !== actualFile.sha256 || expectedFile.bytes !== actualFile.bytes) {
      findings.push({ artifactId: expected.artifactId, path: file, status: 'modified' });
    }
  }
  for (const file of actualFiles.keys()) {
    if (!expectedFiles.has(file)) findings.push({ artifactId: expected.artifactId, path: file, status: 'unexpected' });
  }
  if (expected.digest !== actual.digest && findings.length === 0) {
    findings.push({ artifactId: expected.artifactId, path: 'artifact identity', status: 'metadata-modified' });
  }
  return findings;
}

export function verifyArtifactAttestation(record, expected) {
  if (!expected || expected.artifactId !== record.manifest.id) {
    return [{ artifactId: record.manifest.id, path: 'catalog/integrity.json', status: 'attestation-missing' }];
  }
  return difference(expected, buildArtifactAttestation(record));
}

export function verifyIntegrityManifest(records, expected) {
  const expectedById = new Map(expected.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const actualById = new Map(records.map((record) => [record.manifest.id, record]));
  const findings = [];
  for (const record of records) findings.push(...verifyArtifactAttestation(record, expectedById.get(record.manifest.id)));
  for (const artifactId of expectedById.keys()) {
    if (!actualById.has(artifactId)) findings.push({ artifactId, path: 'artifacts/', status: 'artifact-missing' });
  }
  const rebuilt = buildIntegrityManifest(records);
  if (rebuilt.rootDigest !== expected.rootDigest && findings.length === 0) {
    findings.push({ artifactId: null, path: 'catalog/integrity.json#rootDigest', status: 'root-digest-mismatch' });
  }
  return { rootDigest: expected.rootDigest, artifacts: records.length, findings };
}
