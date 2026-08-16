---
name: write-verifiable-goal-loop
description: "Write a goal-driven agent loop with explicit constraints, validation, checkpoints, progress measures, and termination conditions. Use for long-running autonomous work where a simple step list is insufficient."
---

# Write Verifiable Goal Loop

## Contract

Optimize for the real objective while preventing metric gaming. A loop must always be able to prove progress, pause safely, and terminate.

## Workflow

1. State the objective as an observable outcome, then list non-negotiable constraints, out-of-scope actions, available evidence, and who can authorize scope changes.
2. Define the cycle: inspect current state, choose the smallest useful action, execute within authority, validate the result, and persist a checkpoint. Make repeated cycles idempotent.
3. Choose progress measures that cannot be improved by violating quality, safety, or coverage. Pair every target metric with guardrails and independent validation.
4. Set maximum cycles, time or cost budget, success criteria, stagnation detection, retry limits, and explicit pause conditions. Require a final evidence summary.

## Validation

- A skeptical reader can decide success from the stated evidence.
- The loop stops on success, budget exhaustion, repeated stagnation, or lost authority.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop whenever the next action is irreversible, expands scope, consumes unapproved money, or needs user judgment.

## Refusals

- It does not use vague goals such as make it better without measurable completion.
- It does not reward activity counts that can be gamed instead of outcomes.
- It does not loop indefinitely or hide repeated failure.
