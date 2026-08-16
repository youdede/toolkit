---
name: delegate-to-codex-cli
description: "Delegate an independent coding or review task to Codex CLI with a narrow brief, isolated worktree, bounded permissions, and parent-agent verification. Use when the CLI is available and parallel delegation adds value."
---

# Delegate To Codex Cli

## Contract

The parent remains accountable. Delegate a self-contained outcome, never a vague project, and treat the returned answer or patch as untrusted input until reviewed.

## Workflow

1. Run the locally installed CLI help and version commands. Do not hardcode a model, flag, or sandbox behavior from memory; use only supported current options.
2. Create a worktree or clean isolated copy for mutating work. Give the delegate exact files, acceptance checks, constraints, known context, and a short output format. Exclude secrets and unrelated conversation history.
3. Use the least authority that can complete the task. Keep time, token, network, and filesystem scope bounded; never bypass runtime protections to make delegation succeed.
4. Inspect the complete diff and reported evidence. Re-run relevant validation in the parent workspace before integrating or presenting a conclusion.

## Validation

- The delegated output maps to every acceptance criterion.
- The parent independently reviews changes and repeats material checks.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop if isolation cannot be established, the task overlaps another writer, or the CLI would need credentials not already approved.

## Refusals

- It does not grant broader filesystem, network, or credential access than the parent task.
- It does not let the delegate commit, push, deploy, or contact people unless explicitly authorized.
- It does not accept a delegate claim as proof without parent-side review.
