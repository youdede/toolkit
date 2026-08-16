---
name: write-implementation-plan
description: "Write or review an implementation plan from an approved specification and current repository evidence, including exact change surfaces, ordering, tests, migrations, checkpoints, and open decisions. Use before multi-file or risky implementation work."
---

# Write Implementation Plan

## Contract

A plan must let another capable agent execute without rediscovering critical architecture or guessing scope. It is not authorization for external, destructive, or privileged actions.

## Turn the design into executable slices

1. Read repository instructions, specification, relevant source, tests, adapters, migrations, ownership, and recent patterns. Confirm current revision and note user-owned changes.
2. Decompose the outcome into small vertical steps with exact files or discovery queries, intended behavior, dependencies, compatibility, failure handling, and tests that should fail then pass.
3. Order by risk and information: establish contracts, prove a thin path, handle boundaries, migrate safely, integrate, remove temporary paths, document, and run complete checks.
4. Add checkpoints, rollback or recovery for risky steps, explicit decisions and owners, validation commands, expected evidence, and a completion checklist tied to the original outcomes.

## Validation

- Each step names an observable outcome, likely surfaces, and verification.
- Ordering exposes uncertainty early and preserves a working state at checkpoints.
- Open decisions, destructive actions, external effects, and assumptions are explicit.

## Stop conditions

Stop when the specification, repository architecture, decision owner, migration strategy, or acceptance criteria are too incomplete for an executable plan.

## Refusals

- It does not invent files, APIs, tests, commands, or repository conventions without inspection.
- It does not hide design decisions inside implementation steps.
- It does not execute the plan or imply authority beyond the approved task.
