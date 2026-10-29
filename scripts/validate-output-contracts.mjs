#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Every prompt-bearing payload states one output contract: the headings a reply must carry, in
// order. That line is only useful if it agrees with the rest of the payload and with the artifact's
// behavioral cases. These checks compare the contract against the payload's own text, so a
// contradiction is a build failure rather than something a reader has to notice.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadArtifacts, ROOT } from './lib/catalog.mjs';
import { extractOutputContract } from './lib/output-contract.mjs';

const CONTRACT_LINE = /^Return every one of these headings[^\n]*/m;
const BACKTICKED_HEADING = /`(##\s+[^`]+)`/g;
const NUMBERED_HEADING = /^\s*\d+\.\s*`(##\s+[^`]+)`/gm;
const PROSE_LIST = /Then provide ((?:`[^`]+`(?:, | and |, and )?)+)\./;
// A mention that offers a fallback for an undeclared heading is conditional, not a contradiction.
const CONDITIONAL = /when this contract names that heading|when this contract names no uncertainty section|when it names none, in the first section it names/;

// Known limit: fixed list; `## Validation` and `## Scope` stay allowed because some deliverables use them.
const INSTRUCTION_SECTIONS = new Set(['## Contract', '## Workflow', '## Refusals', '## Output contract']);

const clean = (heading) => heading.replace(/\s+/g, ' ').trim();
const bare = (heading) => clean(heading).replace(/^##\s+/, '');

export function collectContractProblems(root = ROOT) {
  const problems = [];
  const seen = new Set();
  for (const { manifest, directory, adapters } of loadArtifacts(root)) {
    let evaluation = null;
    try {
      evaluation = JSON.parse(readFileSync(path.join(directory, 'evaluations', 'behavioral.json'), 'utf8'));
    } catch {
      evaluation = null;
    }
    for (const adapter of Object.values(adapters ?? {})) {
      for (const entry of adapter.data?.files ?? []) {
        if (!/\.(md|mdc)$/.test(entry.from ?? '')) continue;
        const full = path.join(directory, entry.from);
        if (seen.has(full)) continue;
        seen.add(full);
        let text;
        try {
          text = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        problems.push(...payloadProblems({ manifest, evaluation, file: path.relative(root, full), text }));
      }
    }
  }
  if (seen.size === 0) throw new Error('no prompt payload was read; the artifact layout changed');
  return problems;
}

export function payloadProblems({ manifest, evaluation, file, text }) {
  const found = [];
  const line = text.match(CONTRACT_LINE);
  const id = manifest?.id ?? file;
  // Every evaluated prompt payload names its reply headings. A context is the exception: it is
  // loaded into every session, so a reply contract there would reshape every unrelated reply.
  if (!line) {
    const missing = evaluation && manifest?.kind !== 'context' && extractOutputContract(text).headings.length === 0;
    return missing ? [`${id} (${file}): the payload has no output contract`] : found;
  }
  const contract = [...line[0].matchAll(BACKTICKED_HEADING)].map((m) => clean(m[1]));
  const rest = text.replace(line[0], '');

  if (contract.length === 0) {
    found.push(`${id} (${file}): the output contract names no heading`);
    return found;
  }
  const duplicates = contract.filter((h, i) => contract.indexOf(h) !== i);
  if (duplicates.length > 0) {
    found.push(`${id} (${file}): the output contract repeats ${[...new Set(duplicates)].join(', ')}`);
  }
  // Synonyms are duplicates too: two uncertainty sections split one answer across two places.
  const uncertainty = contract.filter((h) => /uncertaint/i.test(h));
  if (uncertainty.length > 1) {
    found.push(`${id} (${file}): the output contract names more than one uncertainty section: ${uncertainty.join(', ')}`);
  }
  // A reply heading that repeats a heading of the brief (for example `## Scope`) blurs input and output.
  // Known limit: subagents only, because skills still reuse internal headings in their replies.
  if (manifest?.kind === 'subagent') {
    const own = new Set([...rest.matchAll(/^(##\s+.+?)\s*$/gm)].map((m) => clean(m[1])));
    for (const heading of contract.filter((h) => own.has(h))) {
      found.push(`${id} (${file}): '${heading}' is also a heading of the brief itself`);
    }
  }

  // 1. A heading demanded elsewhere, unconditionally, must be in the contract.
  for (const sentence of rest.split(/(?<=\.)\s+/)) {
    if (CONDITIONAL.test(sentence)) continue;
    for (const match of sentence.matchAll(BACKTICKED_HEADING)) {
      const heading = clean(match[1]);
      if (!contract.includes(heading)) {
        found.push(`${id} (${file}): '${heading}' is required outside the output contract but the contract does not name it`);
      }
    }
  }

  // 2. The payload's own numbered list must agree with the contract, membership and order.
  const numbered = [...rest.matchAll(NUMBERED_HEADING)].map((m) => clean(m[1]));
  if (numbered.length === contract.length && numbered.join('|') !== contract.join('|')) {
    found.push(`${id} (${file}): the numbered output list orders headings as ${numbered.join(', ')} but the contract orders them ${contract.join(', ')}`);
  }

  // 3. A prose "Then provide `A`, `B`, and `C`" states a relative order too.
  const prose = rest.match(PROSE_LIST);
  if (prose) {
    const named = [...prose[1].matchAll(/`([^`]+)`/g)]
      .map((m) => `## ${bare(m[1])}`)
      .filter((h) => contract.includes(h));
    const positions = named.map((h) => contract.indexOf(h));
    const ascending = positions.every((v, i, a) => i === 0 || a[i - 1] < v);
    if (named.length >= 2 && !ascending) {
      found.push(`${id} (${file}): the prose orders ${named.join(', ')} but the contract orders them ${contract.join(', ')}`);
    }
  }

  // 4. An instruction pointing at a findings section needs one, or an explicit fallback.
  if (/the findings section this contract names/.test(rest) && !contract.some((h) => /finding/i.test(h))) {
    found.push(`${id} (${file}): an instruction names a findings section that the contract does not declare`);
  }

  // 5. Reply headings must describe the deliverable. Naming the payload's own instruction sections
  // makes every reply restate the procedure instead of presenting the work.
  const own = new Set([...text.matchAll(/^(##\s+.+?)\s*$/gm)].map((m) => clean(m[1])));
  const internal = contract.filter((h) => INSTRUCTION_SECTIONS.has(h) && own.has(h));
  if (internal.length > 0) {
    found.push(`${id} (${file}): the output contract names the payload's own instruction sections ${internal.join(', ')}`);
  }

  // 6. Every section a behavioral case requires must be a heading the contract names.
  for (const item of evaluation?.cases ?? []) {
    for (const section of item.expected?.requiredSections ?? []) {
      if (!contract.includes(`## ${clean(section)}`)) {
        found.push(`${id} (${file}): case '${item.id}' requires section '${section}' but the contract does not name it`);
      }
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = collectContractProblems();
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.stderr.write(`\n${problems.length} output-contract contradictions\n`);
    process.exit(1);
  }
  process.stdout.write('✓ output contracts agree with their payloads and behavioral cases\n');
}
