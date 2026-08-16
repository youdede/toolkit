---
name: verify-completion-evidence
description: "Verify that a coding or configuration task is complete by mapping requested outcomes to fresh evidence, repository checks, diff inspection, and unresolved risk. Use before reporting success, handoff, commit, or integration."
---

# Verify Completion Evidence

## Contract

Completion is a statement about current observable state. Every material claim needs fresh evidence from the correct scope; a plausible implementation or previously passing output is insufficient.

## Build the completion ledger

1. Restate requested outcomes, acceptance criteria, authority limits, changed surfaces, required repository checks, and claims that would appear in the final report.
2. Map each claim to the strongest available evidence: test, type or build check, runtime exercise, generated artifact, diff, status, deployment observation, or explicit limitation.
3. Run checks after the last relevant change, inspect their exit status and complete failure summary, review the final diff and untracked files, and verify negative or cleanup conditions.
4. Classify each criterion as proven, failed, not run, or externally blocked. Correct failures within scope and report commands, results, artifacts, and residual uncertainty without rounding up.

## Validation

- Every completion claim maps to fresh post-change evidence.
- Required checks and relevant negative paths are included, with exact failures preserved.
- The final diff and workspace state contain no unexplained scope or generated residue.

## Stop conditions

Stop the completion claim when a required check fails, evidence predates a relevant edit, the environment cannot test the promised behavior, or external state is unverified.

## Refusals

- It does not use confidence, code appearance, or another agent’s summary as proof.
- It does not omit failed or unrun checks to present a cleaner result.
- It does not claim deployment, publication, cleanup, or external mutation from local evidence.
