#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 10_000;
const MAX_VALUE_CHARS = 160;

const CONSTRAINT_KEYS = [
  'dependentRequired',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'maxContains',
  'maximum',
  'maxItems',
  'maxLength',
  'maxProperties',
  'minContains',
  'minimum',
  'minItems',
  'minLength',
  'minProperties',
  'multipleOf',
  'pattern',
  'uniqueItems'
];

const ANNOTATION_KEYS = ['default', 'deprecated', 'readOnly', 'writeOnly'];
const COMPOSITION_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSchema(value) {
  return typeof value === 'boolean' || isObject(value);
}

function escapePointer(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function joinPointer(pointer, segment) {
  return `${pointer}/${escapePointer(segment)}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function stableString(value) {
  return JSON.stringify(canonicalize(value));
}

function sameValue(left, right) {
  return stableString(left) === stableString(right);
}

function summarize(value) {
  const rendered = stableString(value);
  if (rendered === undefined) return 'not-declared';
  if (rendered.length <= MAX_VALUE_CHARS) return rendered;
  return `${rendered.slice(0, MAX_VALUE_CHARS)}…`;
}

function normalizedTypes(value) {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(String))].sort();
}

function pushSignal(signals, ruleId, pointer, details = {}) {
  signals.push({ ruleId, pointer: pointer || '/', ...details });
}

function compareNamedSchemas(before, after, pointer, keyword, addedRule, removedRule, compare, signals) {
  const beforeMap = isObject(before?.[keyword]) ? before[keyword] : {};
  const afterMap = isObject(after?.[keyword]) ? after[keyword] : {};
  const names = [...new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])].sort();

  for (const name of names) {
    const childPointer = joinPointer(joinPointer(pointer, keyword), name);
    if (!Object.hasOwn(beforeMap, name)) {
      pushSignal(signals, addedRule, childPointer, { subject: name });
    } else if (!Object.hasOwn(afterMap, name)) {
      pushSignal(signals, removedRule, childPointer, { subject: name });
    } else {
      compare(beforeMap[name], afterMap[name], childPointer);
    }
  }
}

function collectReferences(schema, phase) {
  const references = [];
  let nodes = 0;

  function visit(value, pointer, depth) {
    nodes += 1;
    if (nodes > MAX_NODES) throw new Error(`schema exceeds ${MAX_NODES} traversable nodes`);
    if (depth > MAX_DEPTH) throw new Error(`schema exceeds maximum depth ${MAX_DEPTH}`);
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, joinPointer(pointer, index), depth + 1));
      return;
    }
    if (!isObject(value)) return;
    for (const key of Object.keys(value).sort()) {
      const childPointer = joinPointer(pointer, key);
      if ((key === '$ref' || key === '$dynamicRef') && typeof value[key] === 'string') {
        references.push({ phase, pointer: childPointer || '/', reference: value[key] });
      }
      visit(value[key], childPointer, depth + 1);
    }
  }

  visit(schema, '', 0);
  return references;
}

export function compareJsonSchemas(before, after) {
  if (!isSchema(before) || !isSchema(after)) {
    throw new Error('each document root must be a JSON Schema object or boolean');
  }

  const signals = [];
  let comparedNodes = 0;

  function compare(beforeNode, afterNode, pointer, depth = 0) {
    comparedNodes += 1;
    if (comparedNodes > MAX_NODES) throw new Error(`schema comparison exceeds ${MAX_NODES} nodes`);
    if (depth > MAX_DEPTH) throw new Error(`schema comparison exceeds maximum depth ${MAX_DEPTH}`);

    if (!isObject(beforeNode) || !isObject(afterNode)) {
      if (!sameValue(beforeNode, afterNode)) {
        pushSignal(signals, 'SCHEMA_NODE_CHANGED', pointer, {
          before: summarize(beforeNode),
          after: summarize(afterNode)
        });
      }
      return;
    }

    if (!sameValue(normalizedTypes(beforeNode.type), normalizedTypes(afterNode.type))) {
      pushSignal(signals, 'TYPE_CHANGED', joinPointer(pointer, 'type'), {
        before: summarize(normalizedTypes(beforeNode.type)),
        after: summarize(normalizedTypes(afterNode.type))
      });
    }

    const beforeRequired = new Set(Array.isArray(beforeNode.required) ? beforeNode.required.map(String) : []);
    const afterRequired = new Set(Array.isArray(afterNode.required) ? afterNode.required.map(String) : []);
    for (const name of [...afterRequired].filter((name) => !beforeRequired.has(name)).sort()) {
      pushSignal(signals, 'REQUIRED_ADDED', joinPointer(pointer, 'required'), { subject: name });
    }
    for (const name of [...beforeRequired].filter((name) => !afterRequired.has(name)).sort()) {
      pushSignal(signals, 'REQUIRED_REMOVED', joinPointer(pointer, 'required'), { subject: name });
    }

    compareNamedSchemas(beforeNode, afterNode, pointer, 'properties', 'PROPERTY_ADDED', 'PROPERTY_REMOVED', (left, right, child) => compare(left, right, child, depth + 1), signals);
    compareNamedSchemas(beforeNode, afterNode, pointer, 'patternProperties', 'PATTERN_PROPERTY_ADDED', 'PATTERN_PROPERTY_REMOVED', (left, right, child) => compare(left, right, child, depth + 1), signals);
    compareNamedSchemas(beforeNode, afterNode, pointer, '$defs', 'DEFINITION_ADDED', 'DEFINITION_REMOVED', (left, right, child) => compare(left, right, child, depth + 1), signals);
    compareNamedSchemas(beforeNode, afterNode, pointer, 'definitions', 'DEFINITION_ADDED', 'DEFINITION_REMOVED', (left, right, child) => compare(left, right, child, depth + 1), signals);
    compareNamedSchemas(beforeNode, afterNode, pointer, 'dependentSchemas', 'DEPENDENT_SCHEMA_ADDED', 'DEPENDENT_SCHEMA_REMOVED', (left, right, child) => compare(left, right, child, depth + 1), signals);

    if (!sameValue(beforeNode.enum, afterNode.enum)) {
      const beforeValues = Array.isArray(beforeNode.enum) ? new Set(beforeNode.enum.map(stableString)) : new Set();
      const afterValues = Array.isArray(afterNode.enum) ? new Set(afterNode.enum.map(stableString)) : new Set();
      const removedCount = [...beforeValues].filter((value) => !afterValues.has(value)).length;
      const addedCount = [...afterValues].filter((value) => !beforeValues.has(value)).length;
      if (removedCount) pushSignal(signals, 'ENUM_VALUES_REMOVED', joinPointer(pointer, 'enum'), { count: removedCount });
      if (addedCount) pushSignal(signals, 'ENUM_VALUES_ADDED', joinPointer(pointer, 'enum'), { count: addedCount });
    }

    if (!sameValue(beforeNode.const, afterNode.const)) {
      pushSignal(signals, 'CONST_CHANGED', joinPointer(pointer, 'const'));
    }

    const beforeAdditional = beforeNode.additionalProperties === undefined ? true : beforeNode.additionalProperties;
    const afterAdditional = afterNode.additionalProperties === undefined ? true : afterNode.additionalProperties;
    if (!sameValue(beforeAdditional, afterAdditional)) {
      pushSignal(signals, 'ADDITIONAL_PROPERTIES_CHANGED', joinPointer(pointer, 'additionalProperties'), {
        before: summarize(beforeAdditional),
        after: summarize(afterAdditional)
      });
    }

    for (const keyword of CONSTRAINT_KEYS) {
      if (!sameValue(beforeNode[keyword], afterNode[keyword])) {
        pushSignal(signals, 'CONSTRAINT_CHANGED', joinPointer(pointer, keyword), {
          keyword,
          before: summarize(beforeNode[keyword]),
          after: summarize(afterNode[keyword])
        });
      }
    }

    for (const keyword of ANNOTATION_KEYS) {
      if (!sameValue(beforeNode[keyword], afterNode[keyword])) {
        pushSignal(signals, 'ANNOTATION_CHANGED', joinPointer(pointer, keyword), { keyword });
      }
    }

    for (const keyword of COMPOSITION_KEYS) {
      if (!sameValue(beforeNode[keyword], afterNode[keyword])) {
        pushSignal(signals, 'COMPOSITION_CHANGED', joinPointer(pointer, keyword), { keyword });
      }
    }

    for (const keyword of ['$ref', '$dynamicRef']) {
      if (!sameValue(beforeNode[keyword], afterNode[keyword])) {
        pushSignal(signals, 'REFERENCE_CHANGED', joinPointer(pointer, keyword), { keyword });
      }
    }

    for (const keyword of ['items', 'contains', 'propertyNames', 'if', 'then', 'else', 'not']) {
      if (Object.hasOwn(beforeNode, keyword) && Object.hasOwn(afterNode, keyword)) {
        compare(beforeNode[keyword], afterNode[keyword], joinPointer(pointer, keyword), depth + 1);
      } else if (!sameValue(beforeNode[keyword], afterNode[keyword])) {
        pushSignal(signals, 'SCHEMA_KEYWORD_CHANGED', joinPointer(pointer, keyword), { keyword });
      }
    }

    if (isObject(beforeAdditional) && isObject(afterAdditional)) {
      compare(beforeAdditional, afterAdditional, joinPointer(pointer, 'additionalProperties'), depth + 1);
    }
  }

  compare(before, after, '');
  signals.sort((left, right) => left.pointer.localeCompare(right.pointer) || left.ruleId.localeCompare(right.ruleId) || stableString(left).localeCompare(stableString(right)));
  const byRule = {};
  for (const signal of signals) byRule[signal.ruleId] = (byRule[signal.ruleId] || 0) + 1;

  const references = [
    ...collectReferences(before, 'before'),
    ...collectReferences(after, 'after')
  ].sort((left, right) => left.phase.localeCompare(right.phase) || left.pointer.localeCompare(right.pointer) || left.reference.localeCompare(right.reference));

  return {
    schemaVersion: 1,
    analyzer: 'json-schema-structural-diff',
    verdict: 'not-assessed',
    limitations: [
      'Structural signals are not a compatibility or safety verdict.',
      'References are reported but never resolved.',
      'Registry, codec, application, and producer-consumer semantics are not executed.'
    ],
    summary: {
      signalCount: signals.length,
      unresolvedReferenceCount: references.length,
      byRule
    },
    signals,
    unresolvedReferences: references
  };
}

export function readSchemaFile(file) {
  const absolute = path.resolve(file);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`refusing symbolic-link input: ${file}`);
  if (!stat.isFile()) throw new Error(`input is not a regular file: ${file}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`input exceeds ${MAX_FILE_BYTES} bytes: ${file}`);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`);
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    if (!['--before', '--after'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    if (values[flag]) throw new Error(`duplicate argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    values[flag] = value;
    index += 1;
  }
  if (!values['--before'] || !values['--after']) throw new Error('both --before and --after are required');
  return { before: values['--before'], after: values['--after'] };
}

function main(argv) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      process.stdout.write('Usage: compare-json-schema.mjs --before <old.json> --after <new.json>\n');
      return 0;
    }
    const result = compareJsonSchemas(readSchemaFile(options.before), readSchemaFile(options.after));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
