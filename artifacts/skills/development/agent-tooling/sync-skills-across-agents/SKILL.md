---
name: sync-skills-across-agents
description: "Discover configured skill roots for multiple agent runtimes and synchronize one validated skill with collision, symlink, and removal safeguards. Use when the same portable skill should be available to more than one agent."
---

# Sync Skills Across Agents

## Contract

Discover runtime locations from current documentation and local configuration. Keep one explicit source of truth and never assume a particular home-directory layout.

## Workflow

1. Identify target runtimes, supported scopes, actual skill roots, precedence rules, reload behavior, and whether each destination is a directory, symlink, managed store, or project-local override.
2. Validate the source skill first. Compare destination identity and contents; stop on unmanaged collisions or divergent copies instead of overwriting them.
3. Build a deterministic per-target plan and capture the verifiable pre-install state. Install only in scopes the user authorized, one runtime at a time, through each runtime’s supported mechanism when available. Otherwise copy atomically from the declared source of truth; preserve permissions and exclude runtime-irrelevant metadata only when documented.
4. After each target, record the mutation and its verified reversal. If a later target fails, stop: restore only changes made by this run when the recorded reversal is safe, otherwise preserve the partial state and report the exact successful, failed, and untouched targets. Never describe a partial installation as synchronized.
5. Verify discovery in every runtime and compare content hashes for portable files. Record how to update, reload, and remove each installation independently.

## Validation

- Every target runtime discovers the intended skill in the intended scope.
- Portable payload hashes match the declared source of truth.

If validation fails before any write, correct the plan and repeat the check. After a write, do not retry blindly: use the mutation record to restore verified changes or return a deterministic partial-state report before requesting further authority.

## Stop conditions

Stop before replacing a real directory with a symlink, deleting an orphan, or overwriting a divergent unmanaged skill.

## Refusals

- It does not assume hardcoded personal directories or undocumented runtime behavior.
- It does not overwrite divergent or unmanaged copies without approval.
- It does not delete skills or consolidate directories as a side effect of synchronization.
