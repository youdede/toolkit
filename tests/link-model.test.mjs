import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LINK_KINDS, linkReasonProblems, publicCatalog, publicPackCatalog, validateArtifact, validateRepository } from '../scripts/lib/catalog.mjs';
import { reasonSources, translationProblems } from '../scripts/check-reason-translations.mjs';

// The three link levels as data: required (`prerequisites`), suggested (`suggests`), and related
// (`composesWith`), with a reason for every required and suggested link (`linkReasons`), published in
// catalog/artifacts.json (`links`) and catalog/packs.json (`suggests`) for the website, and translated
// in catalog/reasons.{it,nl}.json. docs/catalog-format.md describes the format.

const SHELL = 'hook/security/application-security/shell-command-guard';
const EGRESS = 'hook/security/network-control/mcp-egress-guard';
const PLAYWRIGHT = 'mcp-server/development/testing/playwright-local-isolated';
const readJson = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

test('a required or suggested link without a reason fails validation, and so does a stray or misshapen reason', () => {
  const { artifacts, taxonomy } = validateRepository();
  const record = artifacts.find(({ manifest }) => manifest.slug === 'commit-guard');
  const broken = structuredClone(record);
  broken.adapters = record.adapters;
  delete broken.manifest.relationships.linkReasons;
  assert.ok(validateArtifact(broken, taxonomy).includes(`relationships.linkReasons needs a reason for prerequisite '${SHELL}'`));

  const base = { prerequisites: ['a/x/y/p'], suggests: ['a/x/y/s'] };
  assert.deepEqual(linkReasonProblems({ ...base, linkReasons: { 'a/x/y/p': 'p needs it to run.', 'a/x/y/s': 'for a reason' } }), []);
  assert.deepEqual(linkReasonProblems({ ...base, linkReasons: { 'a/x/y/p': 'p needs it to run.' } }), ["relationships.linkReasons needs a reason for suggestion 'a/x/y/s'"]);
  const problems = (linkReasons) => linkReasonProblems({ ...base, linkReasons }).join('\n');
  assert.match(problems({ 'a/x/y/p': 'p needs it to run', 'a/x/y/s': 'for a reason' }), /end it as a sentence/);
  assert.match(problems({ 'a/x/y/p': 'p needs it to run.', 'a/x/y/s': 'For a reason.' }), /start it lowercase, without a final period/);
  assert.match(problems({ 'a/x/y/p': `${'x'.repeat(121)}.`, 'a/x/y/s': 'for a reason' }), /one line of 10-120 characters/);
  assert.match(problems({ 'a/x/y/p': 'p needs it to run.', 'a/x/y/s': 'for a reason', 'a/x/y/z': 'for nothing at all' }), /names 'a\/x\/y\/z', which is neither/);
  assert.match(linkReasonProblems({ prerequisites: ['a/x/y/p'], suggests: ['a/x/y/p'], linkReasons: { 'a/x/y/p': 'p needs it to run.' } }).join('\n'), /may not repeat prerequisite/);
});

test('the declared links: advisory prerequisites became suggestions, and the audit companions are suggested', () => {
  const byId = new Map(validateRepository().artifacts.map(({ manifest }) => [manifest.id, manifest]));
  const bySlug = new Map([...byId.values()].map((manifest) => [manifest.slug, manifest]));
  for (const slug of ['audit-repository-instructions', 'preflight-change-environment', 'frame-design-direction']) {
    assert.deepEqual(bySlug.get(slug).relationships.prerequisites, [], slug);
    assert.ok(bySlug.get(slug).relationships.suggests.length > 0, slug);
  }
  assert.deepEqual(bySlug.get('draft-evidenced-plan').relationships.prerequisites, ['context/development/code-quality/coding-style-baseline']);
  for (const slug of ['playwright-local-isolated', 'allowlisted-fetch-readonly', 'repository-git-readonly', 'workspace-files-readonly', 'github-readonly']) {
    assert.deepEqual(bySlug.get(slug).relationships.suggests, [EGRESS], slug);
    assert.doesNotMatch(bySlug.get(slug).relationships.linkReasons[EGRESS], /all (?:network )?traffic|every request/i, slug);
  }
  assert.equal(bySlug.get('database-migration-baseline').relationships.suggests.length, 3);
  assert.deepEqual(bySlug.get('diagnose-ci-failure').relationships.suggests, ['mcp-server/development/agent-tooling/github-readonly']);
  // Every prerequisite of shell-command-guard keeps the approved question text as its reason.
  for (const manifest of byId.values()) {
    if (!manifest.relationships.prerequisites.includes(SHELL)) continue;
    assert.equal(manifest.relationships.linkReasons[SHELL], `${manifest.slug} cannot see hidden commands (e.g. bash -c "$X"): shell-command-guard stops them.`);
  }
});

test('catalog/artifacts.json publishes every link with its kind, reason, and shared targets', () => {
  const { artifacts } = validateRepository();
  const catalog = publicCatalog(artifacts);
  assert.equal(catalog.schemaVersion, 2);
  assert.deepEqual(readJson('catalog/artifacts.json'), JSON.parse(JSON.stringify(catalog)));
  for (const item of catalog.artifacts) {
    assert.deepEqual(Object.keys(item.relationships), ['composesWith', 'conflictsWith', 'supersedes', 'prerequisites', 'suggests', 'linkReasons', 'packIds'], item.id);
  }
  const find = (from, to, kind) => catalog.links.find((link) => link.from === from && link.to === to && link.kind === kind);
  assert.deepEqual(find('hook/security/secrets/commit-guard', SHELL, 'required'), {
    from: 'hook/security/secrets/commit-guard', to: SHELL, kind: 'required',
    reason: 'commit-guard cannot see hidden commands (e.g. bash -c "$X"): shell-command-guard stops them.',
    targets: ['claude-code', 'codex', 'cursor', 'gemini-cli', 'opencode']
  });
  assert.deepEqual(find(PLAYWRIGHT, EGRESS, 'suggested').targets, ['claude-code', 'cursor']);
  // A related pair appears once, from the smaller id; so does a conflicting pair.
  assert.ok(find(EGRESS, PLAYWRIGHT, 'related'));
  assert.equal(find(PLAYWRIGHT, EGRESS, 'related'), undefined);
  for (const link of catalog.links) {
    assert.ok(LINK_KINDS.includes(link.kind), link.kind);
    assert.ok(link.targets.length > 0 || link.kind !== 'required', `${link.from} -> ${link.to}`);
    assert.equal('reason' in link, ['required', 'suggested'].includes(link.kind), `${link.from} -> ${link.to} ${link.kind}`);
    if (['related', 'conflicts'].includes(link.kind)) assert.ok(link.from.localeCompare(link.to) < 0);
  }
  const sorted = [...catalog.links].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || LINK_KINDS.indexOf(a.kind) - LINK_KINDS.indexOf(b.kind));
  assert.deepEqual(catalog.links, sorted);
  const counts = catalog.relationshipGraph;
  assert.equal(counts.linkCounts.required, counts.counts.directedEdges.prerequisites);
  assert.equal(counts.linkCounts.suggested, counts.counts.directedEdges.suggests);
  assert.equal(counts.linkCounts.related, counts.counts.compositionEdges);
  assert.equal(counts.linkCounts.conflicts, counts.counts.conflictEdges);
});

test('catalog/packs.json lists the companions outside each pack that its members suggest', () => {
  const { artifacts, packs } = validateRepository();
  const catalog = publicPackCatalog(packs, artifacts);
  assert.equal(catalog.schemaVersion, 2);
  assert.deepEqual(readJson('catalog/packs.json'), JSON.parse(JSON.stringify(catalog)));
  const pack = (slug) => catalog.packs.find((item) => item.slug === slug);
  assert.deepEqual(pack('browser-verification').suggests, [{ id: EGRESS, reason: 'to check browser tool arguments against declared egress (not page requests)', suggestedBy: [PLAYWRIGHT] }]);
  // Three read-only servers suggest the same guard: one entry.
  const mcp = pack('mcp-baseline').suggests.filter(({ id }) => id === EGRESS);
  assert.equal(mcp.length, 1);
  assert.ok(mcp[0].suggestedBy.length >= 2);
  // remote-review-evidence contains github-readonly, which its command suggests: not listed.
  assert.deepEqual(pack('remote-review-evidence').suggests.map(({ id }) => id), [EGRESS]);
  for (const item of catalog.packs) {
    const members = new Set(item.members.map(({ artifactId }) => artifactId));
    for (const suggestion of item.suggests) assert.equal(members.has(suggestion.id), false, `${item.slug} ${suggestion.id}`);
  }
});

test('link reasons are translated in Italian and Dutch under the source hash', () => {
  const artifacts = readJson('catalog/artifacts.json').artifacts;
  const bundles = { it: readJson('catalog/reasons.it.json'), nl: readJson('catalog/reasons.nl.json') };
  assert.deepEqual(translationProblems(artifacts, bundles), []);
  const { links } = reasonSources(artifacts);
  assert.equal(links.length, artifacts.reduce((count, { relationships }) => count + Object.keys(relationships.linkReasons).length, 0));
  const [from, to] = links[0];

  const missing = structuredClone(bundles);
  delete missing.it.links[from][to];
  assert.deepEqual(translationProblems(artifacts, missing), [`it: missing link translation for ${from} -> ${to}`]);
  const copied = structuredClone(bundles);
  copied.nl.links[from][to] = links[0][2];
  assert.deepEqual(translationProblems(artifacts, copied), [`nl: untranslated link reason for ${from} -> ${to}`]);
  const stray = structuredClone(bundles);
  stray.it.links[from]['not-a-link'] = 'x';
  assert.deepEqual(translationProblems(artifacts, stray), [`it: unknown link ${from} -> not-a-link`]);
  // Editing an English link reason changes the source hash.
  const edited = structuredClone(artifacts);
  const owner = edited.find(({ slug }) => slug === from);
  const [id] = Object.keys(owner.relationships.linkReasons);
  owner.relationships.linkReasons[id] = `${owner.relationships.linkReasons[id]} Edited.`;
  assert.deepEqual(translationProblems(edited, bundles), ['it: source reasons changed', 'nl: source reasons changed']);
});
