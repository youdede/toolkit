---
name: execute-verifiable-plan
description: "Execute an approved implementation plan by validating prerequisites, working in bounded batches, collecting evidence, and escalating material deviations. Use when a reviewed plan already exists and the task requires disciplined delivery rather than replanning from scratch."
---

# Execute Verifiable Plan

## Contract

The plan grants authority only within its stated scope. Verify it against the current repository before acting, preserve checkpoints, and surface deviations that alter architecture, risk, or user-visible outcomes.

## Run the plan with checkpoints

1. Read the complete plan and linked context. Verify revision, prerequisites, paths, commands, authority, dependencies, acceptance criteria, and assumptions against current state.
2. Identify blocking contradictions and batch independent steps into a small reviewable unit. Mark destructive, external, privileged, or irreversible actions for separate authority.
3. Execute each step exactly enough to satisfy its outcome, validate immediately, record command and result, inspect the diff, and stop the batch on unexpected behavior.
4. At the checkpoint report completed outcomes, evidence, deviations, remaining risks, and next batch. Update the plan only for evidenced changes and request direction for material divergence.

## Validation

- Every completed step maps to fresh validation output or an inspectable artifact.
- Batches remain reviewable and the repository is coherent at each checkpoint.
- Plan deviations state cause, impact, decision owner, and revised verification.

## Stop conditions

Stop when the plan conflicts with repository state, required authority is absent, validation fails repeatedly, or a deviation changes architecture, external state, risk, or promised behavior.

## Refusals

- It does not treat an old plan as authority over current evidence.
- It does not skip checks to preserve schedule or hide failed steps inside a batch.
- It does not perform destructive or external actions not authorized by the plan and user.
