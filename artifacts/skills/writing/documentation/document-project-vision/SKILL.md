---
name: document-project-vision
description: "Interview a project owner and write concise vision documentation plus ADRs for durable decisions. Use when essential intent lives in a person’s head and future contributors need trustworthy context."
---

# Document Project Vision

## Contract

Separate enduring vision from individual decisions. Preserve the owner’s meaning, challenge only material contradictions, and update documents incrementally after confirmed answers.

## Workflow

1. Read existing README, product notes, plans, ADRs, and repository state. Identify gaps in purpose, audience, success, non-goals, constraints, and key historical decisions.
2. Ask one plain-language question at a time, starting with why the project exists and who it serves. Follow the answer instead of a rigid questionnaire and quote back ambiguous intent for confirmation.
3. Keep the vision document focused on purpose, users, principles, scope, and success. Record a consequential choice separately as a numbered ADR with status, context, decision, and consequences.
4. After each confirmed answer, make a small edit, show what changed, and track unresolved questions. Finish with a consistency pass across code, docs, plans, and ADRs.

## Validation

- The owner confirms that documents preserve the intended meaning.
- Vision, decisions, and implementation facts are separated and mutually consistent.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop before recording sensitive personal or client information, or when the owner has not confirmed a consequential interpretation.

## Refusals

- It does not invent strategy, rationale, history, or owner approval.
- It does not put every implementation detail into the vision document.
- It does not silently overwrite existing ADRs or erase dissent and uncertainty.
