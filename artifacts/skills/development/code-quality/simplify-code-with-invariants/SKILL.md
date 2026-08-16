---
name: simplify-code-with-invariants
description: "Simplify a bounded implementation by identifying its invariants, consumers, accidental complexity, and available repository patterns, then proving behavior is preserved. Use when code is difficult to reason about but a rewrite would be unnecessarily risky."
---

# Simplify Code With Invariants

## Contract

Simplification removes concepts and states; it is not movement or cosmetic compression. Preserve observable behavior unless a separately approved change names the new contract.

## Reduce the concept count

1. Bound the path, read callers and tests, identify inputs, outputs, side effects, timing, errors, performance constraints, and undocumented behavior relied on by consumers.
2. Name the essential invariants and sources of complexity: duplicated policy, excess states, indirect data flow, premature abstraction, hidden mutation, or obsolete compatibility.
3. Choose the smallest transformation that removes a concept. Prefer existing repository patterns, explicit data flow, local ownership, and deletion over a new general abstraction.
4. Add or strengthen characterization tests, apply one coherent change, run focused and repository-required checks, inspect the diff for behavior drift, and measure the reduction.

## Validation

- Before-and-after concept or state count is explained, not merely line count.
- Tests or reproducible checks cover the preserved invariants and affected consumers.
- The diff removes complexity without broad renaming, formatting, or unrelated architecture work.

## Stop conditions

Stop when observable behavior cannot be characterized, consumers are unknown, the change crosses an unapproved compatibility boundary, or simplification requires a product decision.

## Refusals

- It does not delete behavior because it appears unused without repository evidence.
- It does not replace local complexity with a speculative framework or generic abstraction.
- It does not claim simpler code from fewer lines alone.
