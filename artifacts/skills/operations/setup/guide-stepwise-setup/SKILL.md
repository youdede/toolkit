---
name: guide-stepwise-setup
description: "Walk a user through an unfamiliar environment or integration setup using one atomic action per turn, explicit expected evidence, and a maintained checklist. Use when the user must perform interactive or privileged steps."
---

# Guide Stepwise Setup

## Contract

Reduce working-memory load without losing the full plan. Give exactly one user action, explain why it matters, and wait for observable confirmation before advancing.

## Workflow

1. Build the complete prerequisite and setup checklist from current official documentation and local state. Mark which actions the agent can safely perform and which require the user.
2. Present the goal and at most eight remaining steps as a compact map, then give only the next atomic action with exact command or UI path, expected result, and reversal when relevant.
3. Inspect the user’s returned output or screenshot. Diagnose deviations before moving on; never treat “done” as proof when a verification signal exists.
4. Update the checklist after each verified step. At completion, run an end-to-end check and provide removal, credential-rotation, and troubleshooting notes.

## Validation

- Every completed checklist item has a matching observed signal.
- The final integration works through its real entry point and can be removed.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop before billing, credential creation, permission grants, or destructive changes that were not explicitly approved.

## Refusals

- It does not dump a long unprioritized setup guide on the user.
- It does not ask the user to expose secret values in chat or logs.
- It does not advance past a failed or ambiguous verification step.
