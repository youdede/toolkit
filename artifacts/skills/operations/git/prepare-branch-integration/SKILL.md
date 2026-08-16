---
name: prepare-branch-integration
description: "Prepare a development branch for merge, pull request, handoff, or deliberate retention by verifying repository policy, changes, tests, history, migration risk, and integration options. Use after implementation is complete but before mutating remote or shared branch state."
---

# Prepare Branch Integration

## Contract

Integration authority is distinct from implementation. Inspect current branch and repository policy, verify the actual diff, and present recoverable options before commit, push, merge, deletion, or pull-request actions.

## Establish integration readiness

1. Read repository instructions and resolve branch, base, upstream, worktree, status, untracked files, commits, divergence, and user-owned changes. Identify the intended integration outcome.
2. Review the complete diff and commit set for scope, secrets, generated files, migrations, compatibility, release notes, and unresolved markers. Run required and risk-proportionate checks.
3. Summarize readiness, failures, remaining risk, and exact options: keep local, commit, push, open draft or ready review, merge by approved workflow, or defer. State external effects.
4. Execute only the chosen authorized option, verify resulting refs and remote state, preserve recovery information, and remove a worktree or branch only when its changes are safely integrated and deletion is explicit.

## Validation

- Status, diff, base comparison, required checks, and integration risks are current.
- The selected action and its external or destructive effects were explicit before execution.
- Post-action verification identifies branch, commit, remote or review state, and recovery path.

## Stop conditions

Stop when the base or target is ambiguous, unrelated changes overlap, checks fail, protected workflow is unknown, credentials are missing, or deletion and merge authority is not explicit.

## Refusals

- It does not discard work, force-push, merge, delete branches, or publish without clear authorization.
- It does not hide failing checks, untracked files, migrations, or scope drift.
- It does not claim a branch is integrated from local state alone.
