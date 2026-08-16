---
name: isolate-work-with-worktrees
description: "Create and manage a dedicated Git worktree for an independent change, including environment isolation, verification, and deliberate integration. Use when parallel work would otherwise share files, state, or a branch."
---

# Isolate Work With Worktrees

## Contract

One worktree owns one branch and one bounded task. The primary checkout remains the integration point and worktree-local state must not leak across concurrent runs.

## Workflow

1. Inspect repository status, existing worktrees, branch names, and project instructions. Preserve unrelated changes and choose a new task-specific branch and sibling worktree path.
2. Create the worktree without force. Bootstrap dependencies, generated files, environment configuration, ports, databases, and caches independently; do not symlink mutable state such as dependency folders.
3. Work and validate inside the worktree. Keep commits scoped if commits were requested, and regularly check that no other workspace owns the same branch or external resource.
4. Review the complete diff and verification results in the primary checkout before merge or cherry-pick. Remove the worktree only after integration and only when no uncommitted work remains.

## Validation

- Git reports unique branches and clean ownership for every active worktree.
- The integrated revision passes its checks outside the isolated workspace.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop before removing a dirty worktree, overwriting a branch, or sharing a database, port, or cache that can corrupt another run.

## Refusals

- It does not force-remove a worktree or discard uncommitted changes.
- It does not reuse a branch already checked out elsewhere.
- It does not merge or push merely because isolated tests passed.
