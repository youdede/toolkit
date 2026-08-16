---
name: audit-implicit-decisions
description: "Audit the current work for consequential choices that were made implicitly or with low confidence, then present alternatives and evidence. Use before approval, handoff, or when the user asks what assumptions remain."
---

# Audit Implicit Decisions

## Contract

Report only uncertainty that can change the result. Distinguish a decision from an implementation fact, a user instruction, and a settled project convention.

## Workflow

1. Reconstruct decisions from the request, plan, diff, tool output, and project policy. Mark who made each choice and what evidence supported it.
2. Filter for choices with material impact and genuine uncertainty. Exclude obvious mechanics, user-mandated constraints, and options already ruled out by strong evidence.
3. For each retained item, state the chosen path, confidence, assumption, strongest alternative, tradeoff, and the evidence or user answer that would resolve it.
4. Order by consequence and reversibility. Keep the output short and update the canonical plan or decision record only after the user resolves an item.

## Validation

- Every item points to an actual choice in the current work.
- The proposed alternative is feasible within known constraints.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop when no material uncertain choice remains; say so directly rather than padding the report.

## Refusals

- It does not list every minor implementation choice or restate settled requirements.
- It does not pretend uncertainty merely to create discussion.
- It does not rewrite project decisions without the owner’s confirmation.
