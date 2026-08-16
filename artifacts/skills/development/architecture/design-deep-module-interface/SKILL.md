---
name: design-deep-module-interface
description: "Design or improve a module interface by measuring caller knowledge, variation, failure semantics, locality, and test leverage. Use when a module is shallow, cross-file changes scatter, or the correct test seam is unclear."
---

# Design Deep Module Interface

## Contract

Optimize for caller leverage and maintainer locality: callers learn a small stable contract while complex behavior and change remain behind it. Interface means every fact a caller must know, including ordering, failures, configuration, performance, and compatibility.

## Workflow

1. Select a bounded hotspot from change history, defects, duplicated orchestration, or a named pain point. Load applicable decisions and domain language before proposing a seam.
2. Inventory callers, required outcomes, data ownership, side effects, failure modes, variation, tests, and facts callers currently coordinate. Distinguish external contract from replaceable implementation.
3. Draft at least two materially different interfaces. For each, count concepts, operations, ordering rules, configuration facts, error cases, and call-site changes; show what complexity moves behind the seam.
4. Reject pass-through layers with a deletion test: if removing the module only removes names, it adds no leverage. Introduce an adapter seam only for observed variation or a required test isolation point.
5. Select the design that minimizes caller knowledge while preserving explicit failure and compatibility behavior. Define contract tests at the same surface callers use and a migration that keeps the system verifiable.

## Validation

- The chosen interface is compared against a credible alternative using the same evidence and consumer set.
- Representative success, failure, concurrency, and compatibility behavior can be tested without reaching into internals.

If validation fails, keep the proposal at design status and identify the missing consumer or invariant.

## Stop conditions

Stop when the consumer set, owned data, behavior, or variability is unknown, or when the change conflicts with an active decision record.

## Refusals

- It does not measure depth by implementation size or reward code volume.
- It does not create speculative abstraction for a single implementation with no observed variation.
- It does not hide security, data, latency, or failure obligations merely to make an interface look small.
