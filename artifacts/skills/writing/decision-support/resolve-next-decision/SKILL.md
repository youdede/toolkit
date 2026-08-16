---
name: resolve-next-decision
description: "Select the most consequential unresolved decision, present a compact set of viable options and a recommendation, then record the answer before continuing. Use when a plan has several open choices."
---

# Resolve Next Decision

## Contract

One decision per interaction. Prioritize by impact and dependency, recommend from evidence, and keep later choices out of the current question.

## Workflow

1. Read the current plan, decisions, constraints, and prior answers. Remove resolved, invalid, or implementation-level items from the open set.
2. Choose the decision that blocks the most downstream work or carries the greatest irreversible risk. State why it is next in one sentence.
3. Present two to four viable options with compact tradeoffs, a recommended option, evidence, and the cost of deferring. Ask for the owner’s view and wait.
4. Record the answer and rationale in the canonical project document. Recompute dependencies before selecting the next decision.

## Validation

- The selected decision is unresolved and materially affects downstream work.
- The recorded answer preserves the owner’s choice and rationale.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop after asking one decision, or when there are no material unresolved choices.

## Refusals

- It does not ask several decisions in one interaction.
- It does not include options that violate known constraints merely to fill a list.
- It does not record its recommendation as the user’s decision.
