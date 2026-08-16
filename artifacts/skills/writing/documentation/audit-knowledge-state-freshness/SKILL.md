---
name: audit-knowledge-state-freshness
description: "Audit a bounded notes collection, project memory, or always-loaded context for current-state claims contradicted by newer evidence. Use when an agent gives stale answers or a knowledge base may mix mutable state with append-only events."
---

# Audit Knowledge State Freshness

## Contract

Distinguish mutable state from historical events, preserve source text and chronology, and prioritize the context loaded into every session. Work only within authorized sources and propose one reversible repair before any broader restructuring.

## Audit current claims

1. Define the authorized collection, always-loaded surfaces, subject boundaries, evidence precedence, time boundary, sensitive fields, and whether external verification is allowed. Inventory the actual storage shape instead of assuming pages or Markdown.
2. Extract claims phrased as current state: status, owner, location, version, rate, deadline, dependency, or active policy. Keep dated events separate because later events do not make earlier events false.
3. For each current claim, locate the freshest authorized evidence and record source, observed date, effective date when different, subject identity, and confidence. Classify confirmed, contradicted, unsupported, ambiguous subject, or unverifiable.
4. Review a bounded sample for semantic lifecycle conflicts that simple value comparison misses. Do not declare a zero-finding scan clean when coverage excludes undated prose, external systems, or uncaptured conversations.
5. Lead with contradictions in always-loaded context, then unsupported high-impact claims. Propose a single-location repair that preserves every event and creates one dated source of current state; show the exact diff and ask before writing.
6. Recommend a sustainable update path: replace current state, append events, record evidence timestamps, and schedule a bounded recheck where staleness has material impact.

## Validation

- Every contradiction cites both the current claim and newer authorized evidence.
- Historical events remain intact and ambiguous subjects remain unresolved rather than merged.
- Coverage and private-data handling are explicit; no finding echoes unnecessary sensitive content.

## Output

Return scope and coverage, confirmed claims summary, contradicted and unsupported claims, ambiguous items, the proposed one-location repair, and recurrence controls.

## Stop conditions

Stop when source authority, subject identity, chronology, consent, or privacy constraints cannot be resolved safely.

## Refusals

- It does not bulk-restructure notes or rewrite append-only history.
- It does not infer a current value when evidence order or subject identity is ambiguous.
- It does not expose, transmit, or unnecessarily repeat private facts found during the audit.
