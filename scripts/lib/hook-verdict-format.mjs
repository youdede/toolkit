// Storage format of quality/hook-verdicts.json. Schema 2 stores each execution case once with a
// `results` map keyed by hook; schema 1 stored one flat row per case and hook, repeating a shared
// command up to 31 times. The recorder, the verdict test, and the quarantine gate read the flat rows,
// so `expandSnapshot` rebuilds them in memory and `compactSnapshot` groups them again on write.
import { createHash } from 'node:crypto';

const CASE_KEYS = ['raw', 'input', 'fixture', 'via', 'env'];
const verdict = (value) => ({ exit: value.exit, ruleId: value.ruleId, output: value.output });
const sameVerdict = (a, b) => a.exit === b.exit && a.ruleId === b.ruleId && a.output === b.output;
const effective = (result) => (result.change && 'exit' in result.change ? verdict(result.change) : result.expected);

const fieldsOf = (entry) => Object.fromEntries(CASE_KEYS.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]));

function resultOf(entry) {
  // A row not recorded yet has no verdict, so the recorder still sees it as new.
  const result = { source: entry.source, ...('exit' in entry && { expected: verdict(entry) }) };
  for (const key of ['expectation', 'change', 'nodeVariants']) if (entry[key] !== undefined) result[key] = entry[key];
  return result;
}

// Two rows for the same hook and case run the same process twice. They merge when their effective
// verdicts, expectations, and Node.js variants agree; the row with a `change` wins and the sources join
// with "; ".
function mergeDuplicate(existing, incoming, label) {
  if (!sameVerdict(effective(existing), effective(incoming))) throw new Error(`${label} has conflicting effective verdicts`);
  for (const key of ['expectation', 'nodeVariants']) {
    if (existing[key] !== undefined && incoming[key] !== undefined && JSON.stringify(existing[key]) !== JSON.stringify(incoming[key])) {
      throw new Error(`${label} has conflicting ${key}`);
    }
  }
  const source = [...new Set([...existing.source.split('; '), incoming.source])].join('; ');
  const expectation = existing.expectation ?? incoming.expectation;
  const nodeVariants = existing.nodeVariants ?? incoming.nodeVariants;
  if (!existing.change && incoming.change) Object.assign(existing, incoming);
  if (expectation !== undefined) existing.expectation = expectation;
  if (nodeVariants !== undefined) existing.nodeVariants = nodeVariants;
  existing.source = source;
}

export function compactSnapshot(document) {
  if (!Array.isArray(document.entries)) throw new Error('flat snapshot entries are required');
  const groups = new Map();
  const ids = new Map();
  for (const entry of document.entries) {
    const fields = fieldsOf(entry);
    const serialized = JSON.stringify(fields);
    const id = createHash('sha256').update(serialized).digest('hex').slice(0, 16);
    if (ids.has(id) && ids.get(id) !== serialized) throw new Error(`case id collision for ${id}`);
    ids.set(id, serialized);
    let item = groups.get(serialized);
    if (!item) groups.set(serialized, (item = { id, ...fields, results: {} }));
    const incoming = resultOf(entry);
    if (item.results[entry.hook]) mergeDuplicate(item.results[entry.hook], incoming, `${id}/${entry.hook}`);
    else item.results[entry.hook] = incoming;
  }
  // A source shared by every hook of a case is stored once on the case.
  for (const item of groups.values()) {
    const results = Object.values(item.results);
    const sources = new Set(results.map((result) => result.source));
    if (results.every((result) => result.source !== undefined) && sources.size === 1) {
      item.source = [...sources][0];
      for (const result of results) delete result.source;
    }
  }
  const { entries: _entries, cases: _cases, ...top } = document;
  return { ...top, schemaVersion: 2, cases: [...groups.values()] };
}

export function expandSnapshot(document) {
  if (document.schemaVersion !== 2) return document;
  if (!Array.isArray(document.cases)) throw new Error('schemaVersion 2 cases are required');
  const entries = document.cases.flatMap(({ id: _id, results, source: caseSource, ...fields }) =>
    Object.entries(results).map(([hook, { expected, source, ...metadata }]) => ({
      hook, ...fields, source: source ?? caseSource, ...metadata, ...expected
    })));
  const { cases: _cases, ...top } = document;
  return { ...top, entries };
}

// One case per line keeps the diff of a verdict change on the case that changed.
export function serializeCompactSnapshot(document) {
  const { cases, fixtures, ...head } = compactSnapshot(document);
  const top = Object.entries(head).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  const fixtureLines = Object.entries(fixtures).map(([name, steps]) => `    ${JSON.stringify(name)}: ${JSON.stringify(steps)}`);
  const caseLines = cases.map((item) => `    ${JSON.stringify(item)}`);
  return `{\n${top.join('\n')}\n  "fixtures": {\n${fixtureLines.join(',\n')}\n  },\n  "cases": [\n${caseLines.join(',\n')}\n  ]\n}\n`;
}
