---
name: write-verifiable-specification
description: "Write or review a feature or system specification from repository evidence, user outcomes, constraints, interfaces, failure states, decisions, and acceptance checks. Use before implementation when ambiguity spans multiple components or stakeholders."
---

# Write Verifiable Specification

## Contract

A specification resolves consequential decisions and makes remaining uncertainty visible. It describes required outcomes and boundaries without inventing authority or prescribing incidental code structure.

## Resolve the implementation contract

1. Gather problem evidence, users, current behavior, repository architecture, owners, constraints, non-goals, dependencies, risks, and concrete examples.
2. Define outcomes, domain terms, invariants, flows, states, permissions, data, interfaces, compatibility, failure and recovery, observability, rollout, and support expectations.
3. Record decisions and alternatives with rationale. Turn requirements into verifiable acceptance scenarios covering success, boundary, malformed, unauthorized, partial, concurrent, migration, and rollback behavior.
4. Run a contradiction and implementability review against code and stakeholders, close blocking questions, assign remaining decisions, and link the spec to the plan and validation artifacts.

## Validation

- Requirements are traceable to evidence and acceptance scenarios.
- Interfaces, state transitions, failure behavior, authority, non-goals, and rollout are explicit.
- Open questions have owners and do not conceal implementation-blocking decisions.

## Stop conditions

Stop when the problem owner, required authority, system boundary, security or data constraints, or a decision that changes scope cannot be resolved.

## Refusals

- It does not fabricate requirements, stakeholder agreement, dates, or system guarantees.
- It does not replace design decisions with vague adjectives such as scalable or robust.
- It does not start implementation or present unresolved scope as approved.
