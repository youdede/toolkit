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

const BACKTICKED_HEADING = /`(##\s+[^`]+)`/g;
const NUMBERED_HEADING = /^\s*\d+\.\s*`(##\s+[^`]+)`/gm;
const BULLETED_HEADING = /^\s*[-*]\s*`(##\s+[^`]+)`/gm;
const PROSE_LIST = /Then provide ((?:`[^`]+`(?:, | and |, and )?)+)\./;
// A mention that offers a fallback for an undeclared heading is conditional, not a contradiction.
const CONDITIONAL = /when this contract names that heading|when this contract names no uncertainty section|when it names none, in the first section it names/;

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
  const id = manifest?.id ?? file;
  const parsed = extractOutputContract(text);
  if (parsed.sections === 0) {
    found.push(`${id} (${file}): missing a ## Output contract section`);
    return found;
  }
  if (parsed.sections > 1) {
    found.push(`${id} (${file}): declares ${parsed.sections} ## Output contract sections`);
    return found;
  }
  const contract = parsed.headings;
  const rest = text;

  if (contract.length === 0) {
    found.push(`${id} (${file}): the output contract names no heading`);
    return found;
  }
  const duplicates = contract.filter((h, i) => contract.indexOf(h) !== i);
  if (duplicates.length > 0) {
    found.push(`${id} (${file}): the output contract repeats ${[...new Set(duplicates)].join(', ')}`);
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

  // 2. Ordered heading lists must preserve the contract's relative order. A partial list can still
  // contradict the contract, so it is checked rather than silently ignored.
  for (const [label, pattern] of [['numbered', NUMBERED_HEADING], ['bulleted', BULLETED_HEADING]]) {
    const listed = [...rest.matchAll(pattern)].map((m) => clean(m[1])).filter((heading) => contract.includes(heading));
    const positions = listed.map((heading) => contract.indexOf(heading));
    const ascending = positions.every((value, index) => index === 0 || positions[index - 1] < value);
    if (listed.length >= 2 && !ascending) {
      found.push(`${id} (${file}): the ${label} output list orders headings as ${listed.join(', ')} but the contract orders them ${contract.join(', ')}`);
    }
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

  // 4. Explicit first/last instructions must name the first/last contract heading. These forms
  // occur in hand-authored payloads without backticks, so compare normalized heading text too.
  const normalizedContract = contract.map((heading) => bare(heading).toLocaleLowerCase('en-US'));
  const endpointPatterns = [
    ['first', /\b(?:start|begin)(?: the reply| the response)? with\s+(?:`##\s+([^`]+)`|([^.;\n]+))/giu, 0],
    ['last', /\b(?:end|finish)(?: the reply| the response)? with\s+(?:`##\s+([^`]+)`|([^.;\n]+))/giu, contract.length - 1]
  ];
  for (const [label, pattern, expectedIndex] of endpointPatterns) {
    for (const match of rest.matchAll(pattern)) {
      const named = clean(match[1] || match[2]).replace(/^(?:the\s+)?/iu, '').toLocaleLowerCase('en-US');
      const actualIndex = normalizedContract.indexOf(named);
      if (actualIndex >= 0 && actualIndex !== expectedIndex) {
        found.push(`${id} (${file}): an instruction makes ${contract[actualIndex]} ${label}, but the contract makes ${contract[expectedIndex]} ${label}`);
      }
    }
  }

  // 5. An unconditional exception that omits contract sections contradicts an every-path contract.
  for (const match of rest.matchAll(/\b(?:on failure|when declining|when inputs are missing)[^\n.]{0,120}\b(?:omit|exclude) every section except\s+`(##\s+[^`]+)`/giu)) {
    const kept = clean(match[1]);
    if (contract.includes(kept) && contract.length > 1) {
      found.push(`${id} (${file}): an exceptional path omits contract headings other than ${kept}`);
    }
  }

  // 6. An instruction pointing at a findings section needs one, or an explicit fallback.
  if (/the findings section this contract names/.test(rest) && !contract.some((h) => /finding/i.test(h))) {
    found.push(`${id} (${file}): an instruction names a findings section that the contract does not declare`);
  }

  // 7. Every section a behavioral case requires must be a heading the contract names.
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
