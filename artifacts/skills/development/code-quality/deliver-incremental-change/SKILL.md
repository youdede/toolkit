---
name: deliver-incremental-change
description: "Break and deliver a bounded implementation in vertical, behaviorally verifiable slices with explicit invariants, checkpoints, and integration evidence. Use when a change is too large for one safe edit but can progress without speculative scaffolding."
---

# Deliver Incremental Change

## Contract

Each slice must create or prove observable value while keeping the repository coherent. Sequence by risk and learning, not by architectural layer convenience.

## Slice by observable behavior

1. Define target behavior, invariants, dependencies, integration boundary, risks, required checks, and the smallest end-to-end scenario that can be proved.
2. Partition work into slices that each include necessary interfaces, implementation, tests, migration or flags, and cleanup. Identify ordering, reversible checkpoints, and deferred decisions.
3. For each slice create failing evidence, implement only the needed path, run focused and repository checks, inspect the diff, and integrate before starting the next slice.
4. After every checkpoint update the plan from evidence, remove temporary scaffolding, verify compatibility and rollout state, and stop when new information changes scope.

## Validation

- Every slice has an observable acceptance check and leaves the system in a valid state.
- Dependencies and temporary compatibility paths have owners and removal conditions.
- Final verification proves integrated behavior, not only isolated components.

## Stop conditions

Stop when no safe vertical slice exists, required interfaces are undecided, migration is irreversible without approval, or discovered scope exceeds the authorized change.

## Refusals

- It does not build unused layers or abstractions for hypothetical future slices.
- It does not defer tests, integration, migration safety, or cleanup to an undefined final phase.
- It does not hide new scope inside an implementation checkpoint.
