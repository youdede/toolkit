---
name: resolve-merge-conflicts-by-intent
description: "Resolve an in-progress merge, rebase, or cherry-pick by tracing each side to its intent, selecting an explicit combined behavior, and verifying the resulting history. Use when conflict markers require semantic rather than mechanical resolution."
---

# Resolve Merge Conflicts By Intent

## Contract

Resolve only the active Git operation and the user's named scope. A conflict hunk is evidence of two histories, not permission to discard either. Finishing, committing, pushing, or aborting are separate actions unless explicitly authorized.

## Workflow

1. Capture status, operation type, current branch, heads being combined, conflict list, rerere state, and user-owned changes. Preserve a recoverable reference before editing when repository policy permits.
2. For each hunk, inspect base, ours, theirs, surrounding code, originating commits, tests, issues, and related call sites. State each side's intended behavior and whether the intents are compatible.
3. Choose preserve-both, select-one, or synthesize-new behavior. Explain the choice before applying it; never use blanket ours/theirs for mixed semantic conflicts.
4. Remove markers, inspect the complete file and diff, and search for duplicated declarations, lost imports, stale generated outputs, schema drift, and conflict markers outside Git's list.
5. Run the narrow tests for both intents, then repository-required checks. Report unresolved trade-offs and request authority before continuing or finalizing the Git operation.

## Validation

- Every resolved file has an intent record and no conflict marker remains.
- Tests exercise behavior contributed by both sides or document why one intent was deliberately superseded.

If validation fails, leave the operation unfinalized and report the exact conflicting evidence.

## Stop conditions

Stop when intent cannot be reconstructed, user changes overlap, a generated file lacks its source, or resolution requires a product decision.

## Refusals

- It does not automatically abort, continue, commit, push, or force-update history.
- It does not choose an entire side merely because it compiles or has the newer timestamp.
- It does not rewrite unrelated files or hide verification failures inside conflict cleanup.
