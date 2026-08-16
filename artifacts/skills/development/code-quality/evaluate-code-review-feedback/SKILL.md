---
name: evaluate-code-review-feedback
description: "Evaluate code-review feedback by reconstructing the claimed failure, checking repository evidence, and deciding whether to accept, refine, reject, or escalate it. Use when review comments are ambiguous, disputed, broad, or potentially incorrect."
---

# Evaluate Code Review Feedback

## Contract

Review feedback is a hypothesis about risk or maintainability, not an instruction that overrides evidence. Understand the claim and affected contract before editing.

## Verify the review claim

1. Read the full comment in diff context and restate the claimed behavior, affected scenario, severity, requested outcome, and unresolved ambiguity without adding assumptions.
2. Inspect the referenced code, callers, tests, repository conventions, versioned documentation, and runtime evidence. Reproduce the issue or construct the smallest discriminating check.
3. Classify the feedback as valid, valid with a different remedy, unsupported, duplicate, out of scope, or requiring an owner decision. Explain evidence and tradeoffs.
4. For accepted feedback, implement one bounded correction and run focused plus required checks. Reply with changed behavior and evidence; for rejected feedback, respond concretely and invite missing evidence.

## Validation

- The disposition cites code or behavior evidence rather than agreement language.
- Accepted changes include a regression or verification capable of exposing the original issue.
- Replies separate facts, inference, and decisions requiring reviewer or owner input.

## Stop conditions

Stop when the intended contract, reviewer meaning, reproduction environment, or scope authority is ambiguous enough that implementation could solve a different problem.

## Refusals

- It does not apply feedback merely to appear agreeable or reject it defensively.
- It does not broaden a comment into unrelated cleanup or architecture work.
- It does not claim resolution without fresh evidence and a precise response.
