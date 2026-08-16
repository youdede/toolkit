---
name: write-session-handoff
description: "Write a concise session handoff containing objective, verified state, decisions, changed files, validation, dead ends, and next action. Use before context loss, agent transfer, or an intentional pause."
---

# Write Session Handoff

## Contract

A handoff records state and evidence, not a new mandate. Reference durable project documents instead of duplicating them and separate facts from proposed next steps.

## Workflow

1. Resolve this skill's installed directory and run `node scripts/collect-git-state.mjs --cwd <repository>` to capture revision, branch, upstream, status, diff statistics, and recent commits deterministically. Inspect the active plan, relevant task text, and latest validation separately; do not rely on memory when the repository can answer.
2. Record the objective and scope, what is complete, what remains, key decisions with rationale, exact changed files, commands and outcomes, blockers, and the single best next action.
3. Include dead ends only when they prevent repeated work. Link to source files, plans, ADRs, issues, and reports rather than copying long content.
4. Redact credentials, personal data, transient tokens, and machine-specific paths. Re-read the handoff against actual state and clearly label uncertainty.

## Validation

- Paths, revision, status, and test claims match current tool output.
- A new agent can identify the next action without guessing authority or scope.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop and label the handoff incomplete when repository state or verification cannot be inspected.

## Refusals

- It does not invent completed work, passing checks, or decisions.
- It does not include credentials, private payloads, or unnecessary personal data.
- It does not silently turn suggestions into instructions or authorization.
