#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, validateRepository } from './lib/catalog.mjs';

const CASE_TYPES = new Set(['positive', 'negative', 'malformed', 'boundary']);
const DISPOSITIONS = new Set(['apply', 'decline', 'clarify', 'limit']);
const REQUIRED_DISPOSITIONS = {
  positive: new Set(['apply']),
  negative: new Set(['decline']),
  malformed: new Set(['clarify', 'decline']),
  boundary: new Set(['limit', 'decline'])
};
const MAX_RESPONSE_BYTES = 1_000_000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonEmptyString(value, { min = 1, max = 500 } = {}) {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}

function uniqueStrings(value, { min = 1, max = 500 } = {}) {
  return Array.isArray(value)
    && value.length >= min
    && new Set(value).size === value.length
    && value.every((item) => nonEmptyString(item, { min: 3, max }));
}

function normalize(value) {
  return value.toLocaleLowerCase('en-US');
}

function evaluationPath(record) {
  return path.join(record.directory, 'evaluations', 'behavioral.json');
}

function payloadFor(record) {
  if (record.manifest.kind === 'skill') {
    const file = path.join(record.directory, 'SKILL.md');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  const mappedFiles = Object.values(record.adapters)
    .flatMap(({ data }) => data.files || [])
    .map(({ from }) => path.resolve(record.directory, from))
    .filter((file) => existsSync(file) && statSync(file).isFile());
  return [...new Set(mappedFiles)].map((file) => readFileSync(file, 'utf8')).join('\n');
}

function error(errors, prefix, message) {
  errors.push(`${prefix}: ${message}`);
}

function validateExpected(expected, prefix, errors) {
  const keys = ['disposition', 'requiredSections', 'requiredEvidence', 'forbiddenClaims', 'forbiddenActions'];
  if (!hasExactKeys(expected, keys)) {
    error(errors, prefix, `expected must contain only ${keys.join(', ')}`);
    return;
  }
  if (!DISPOSITIONS.has(expected.disposition)) error(errors, prefix, 'expected.disposition is invalid');
  for (const key of keys.slice(1)) {
    if (!uniqueStrings(expected[key])) error(errors, prefix, `expected.${key} must be a non-empty, unique list of short strings`);
  }
}

export function validateEvaluationDocument(document, record, source = payloadFor(record)) {
  const errors = [];
  const prefix = record.manifest.id;
  const documentKeys = ['$schema', 'schemaVersion', 'artifactId', 'cases'];
  if (!hasExactKeys(document, documentKeys)) {
    error(errors, prefix, 'document must be an object with only $schema, schemaVersion, artifactId, and cases');
    return errors;
  }
  if (document.schemaVersion !== 1) error(errors, prefix, 'schemaVersion must be 1');
  if (document.artifactId !== record.manifest.id) error(errors, prefix, 'artifactId must match the owning manifest');
  if (!nonEmptyString(document.$schema, { min: 10, max: 500 })) error(errors, prefix, '$schema must be a non-empty schema reference');
  if (!Array.isArray(document.cases) || document.cases.length < 4) {
    error(errors, prefix, 'cases must contain at least one positive, negative, malformed, and boundary case');
    return errors;
  }

  const ids = new Set();
  const types = new Set();
  const normalizedSource = normalize(source);
  for (const [index, item] of document.cases.entries()) {
    const casePrefix = `${prefix} case[${index}]`;
    const keys = ['id', 'type', 'prompt', 'sourceAnchors', 'expected'];
    if (!hasExactKeys(item, keys)) {
      error(errors, casePrefix, `must contain only ${keys.join(', ')}`);
      continue;
    }
    if (!nonEmptyString(item.id, { min: 3, max: 80 }) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) error(errors, casePrefix, 'id must be lowercase hyphen-case');
    else if (ids.has(item.id)) error(errors, casePrefix, `duplicates case id '${item.id}'`);
    else ids.add(item.id);
    if (!CASE_TYPES.has(item.type)) error(errors, casePrefix, 'type must be positive, negative, malformed, or boundary');
    else types.add(item.type);
    if (!nonEmptyString(item.prompt, { min: 20, max: 3000 })) error(errors, casePrefix, 'prompt must contain 20-3000 characters');
    if (!uniqueStrings(item.sourceAnchors, { min: 2 })) error(errors, casePrefix, 'sourceAnchors must name at least two unique prompt anchors');
    else {
      for (const anchor of item.sourceAnchors) {
        if (!normalizedSource.includes(normalize(anchor))) error(errors, casePrefix, `source anchor is absent from the artifact payload: '${anchor}'`);
      }
    }
    validateExpected(item.expected, casePrefix, errors);
    if (CASE_TYPES.has(item.type) && item.expected && !REQUIRED_DISPOSITIONS[item.type].has(item.expected.disposition)) {
      error(errors, casePrefix, `${item.type} cases require disposition ${[...REQUIRED_DISPOSITIONS[item.type]].join(' or ')}`);
    }
  }
  for (const type of CASE_TYPES) if (!types.has(type)) error(errors, prefix, `cases must include a ${type} scenario`);
  return errors;
}

export function loadBehavioralEvaluations(root = ROOT) {
  const { artifacts, results } = validateRepository(root);
  const requiredRecords = artifacts.filter(({ manifest }) => manifest.kind === 'skill' || manifest.kind === 'subagent');
  const requiredIds = new Set(requiredRecords.map(({ manifest }) => manifest.id));
  const records = artifacts.filter((record) => requiredIds.has(record.manifest.id) || existsSync(evaluationPath(record)));
  const evaluatedIds = new Set(records.map(({ manifest }) => manifest.id));
  const errors = results
    .filter(({ record }) => evaluatedIds.has(record.manifest.id))
    .flatMap(({ record, errors: found }) => found.map((message) => `${record.manifest.id}: artifact validation failed: ${message}`));
  const documents = [];

  for (const record of records) {
    const file = evaluationPath(record);
    if (!existsSync(file)) {
      errors.push(`${record.manifest.id}: missing evaluations/behavioral.json`);
      continue;
    }
    let document;
    try {
      document = JSON.parse(readFileSync(file, 'utf8'));
    } catch (cause) {
      errors.push(`${record.manifest.id}: evaluations/behavioral.json is not valid JSON: ${cause.message}`);
      continue;
    }
    const schemaReference = path.resolve(path.dirname(file), document.$schema || '');
    if (schemaReference !== path.join(root, 'schema', 'evaluation.schema.json')) {
      errors.push(`${record.manifest.id}: $schema must resolve to schema/evaluation.schema.json`);
    }
    const found = validateEvaluationDocument(document, record);
    errors.push(...found);
    documents.push({ record, file, document });
  }
  return { records, documents, errors };
}

export function validateBehavioralEvaluations(root = ROOT) {
  const result = loadBehavioralEvaluations(root);
  return { ...result, valid: result.errors.length === 0 };
}

function sectionPresent(text, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, 'imu').test(text);
}

export function validateResponseEnvelope(envelope, documents) {
  const errors = [];
  if (!hasExactKeys(envelope, ['schemaVersion', 'artifactId', 'responses'])) {
    return { valid: false, errors: ['response envelope must contain only schemaVersion, artifactId, and responses'] };
  }
  if (envelope.schemaVersion !== 1) errors.push('response envelope schemaVersion must be 1');
  const documentRecord = documents.find(({ record }) => record.manifest.id === envelope.artifactId);
  if (!documentRecord) errors.push(`response envelope names an unknown evaluated artifact '${envelope.artifactId}'`);
  if (!Array.isArray(envelope.responses) || envelope.responses.length === 0) errors.push('response envelope responses must be a non-empty array');
  if (errors.length > 0) return { valid: false, errors };

  const cases = new Map(documentRecord.document.cases.map((item) => [item.id, item]));
  const seen = new Set();
  for (const [index, response] of envelope.responses.entries()) {
    const prefix = `response[${index}]`;
    if (!hasExactKeys(response, ['caseId', 'disposition', 'text'])) {
      errors.push(`${prefix} must contain only caseId, disposition, and text`);
      continue;
    }
    if (!cases.has(response.caseId)) {
      errors.push(`${prefix} names unknown case '${response.caseId}'`);
      continue;
    }
    if (seen.has(response.caseId)) errors.push(`${prefix} repeats case '${response.caseId}'`);
    seen.add(response.caseId);
    if (!nonEmptyString(response.text, { min: 1, max: MAX_RESPONSE_BYTES })) {
      errors.push(`${prefix}.text must contain 1-${MAX_RESPONSE_BYTES} characters`);
      continue;
    }
    const expected = cases.get(response.caseId).expected;
    if (!isPlainObject(expected)
      || !Array.isArray(expected.requiredSections)
      || !Array.isArray(expected.requiredEvidence)
      || !Array.isArray(expected.forbiddenClaims)
      || !Array.isArray(expected.forbiddenActions)) {
      errors.push(`${prefix} cannot be checked because its behavioral contract is invalid`);
      continue;
    }
    if (!DISPOSITIONS.has(response.disposition)) {
      errors.push(`${prefix}.disposition must be apply, decline, clarify, or limit`);
    } else if (response.disposition !== expected.disposition) {
      errors.push(`${prefix}.disposition '${response.disposition}' does not match expected '${expected.disposition}'`);
    }
    const normalized = normalize(response.text);
    for (const section of expected.requiredSections) if (!sectionPresent(response.text, section)) errors.push(`${prefix} is missing required section '${section}'`);
    for (const evidence of expected.requiredEvidence) if (!normalized.includes(normalize(evidence))) errors.push(`${prefix} is missing required evidence '${evidence}'`);
    for (const claim of expected.forbiddenClaims) if (normalized.includes(normalize(claim))) errors.push(`${prefix} contains forbidden claim '${claim}'`);
    for (const action of expected.forbiddenActions) if (normalized.includes(normalize(action))) errors.push(`${prefix} contains forbidden action '${action}'`);
  }
  return { valid: errors.length === 0, errors };
}

function parseArguments(argv) {
  const options = { root: ROOT, responses: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--root' || option === '--responses') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a path`);
      options[option === '--root' ? 'root' : 'responses'] = path.resolve(value);
    }
    else if (option === '--json') options.json = true;
    else throw new Error(`unknown argument '${option}'`);
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = validateBehavioralEvaluations(options.root);
  const responseResult = options.responses === null ? null : (() => {
    if (!result.valid) return { valid: false, errors: ['response validation requires valid behavioral contracts'] };
    if (!existsSync(options.responses)) return { valid: false, errors: [`response file is missing: ${options.responses}`] };
    if (statSync(options.responses).size > MAX_RESPONSE_BYTES) return { valid: false, errors: [`response file exceeds ${MAX_RESPONSE_BYTES} bytes`] };
    try {
      return validateResponseEnvelope(JSON.parse(readFileSync(options.responses, 'utf8')), result.documents);
    } catch (cause) {
      return { valid: false, errors: [`response file is not valid JSON: ${cause.message}`] };
    }
  })();
  const valid = result.valid && (responseResult === null || responseResult.valid);
  const output = {
    valid,
    evaluatedArtifacts: result.records.map(({ manifest }) => manifest.id),
    declarationErrors: result.errors,
    responseErrors: responseResult?.errors || []
  };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else if (valid) process.stdout.write(`✓ ${result.documents.length} behavioral evaluation contracts valid.\n`);
  else for (const failure of [...output.declarationErrors, ...output.responseErrors]) process.stderr.write(`✗ ${failure}\n`);
  if (!valid) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (cause) {
    process.stderr.write(`validate-evaluations: ${cause.message}\n`);
    process.exitCode = 1;
  }
}
