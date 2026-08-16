---
name: author-guided-setup-wizard
description: "Author a bounded shell wizard for manual setup steps that require human interaction, credentials, dashboards, or irreversible confirmation. Use when automation cannot complete the procedure but a repeatable guided path is valuable."
---

# Author Guided Setup Wizard

## Contract

Use a wizard only for actions the agent cannot safely perform. Define stages, captured values, destinations, secret classification, prerequisites, retries, cleanup, and irreversible actions before writing code. The generated wizard requires human execution.

## Workflow

1. Inspect current configuration, examples, CI references, documentation, and official provider instructions. Separate agent-executable preparation from user-only dashboard, billing, identity, or secret steps.
2. Present the ordered stage contract. For each stage record the exact user action, expected evidence, produced value, secret status, persistence destination, idempotency, and recovery path; obtain approval before authoring.
3. Write one self-contained Bash script with strict mode, numbered stages, visible progress, resumable non-secret state, cross-platform URL hints, hidden secret input, quoted variables, and atomic configuration updates. Require typed confirmation immediately before every irreversible or billable action.
4. Keep secrets in process memory only as long as needed. Never echo them, pass them on command lines where process listings expose them, store them in resume state, or send them anywhere not named in the approved contract.
5. Run `node scripts/validate-setup-wizard.mjs <wizard.sh>` from this installed skill, then run shellcheck when available. Trace every stage statically; do not execute the full wizard on the user's behalf.

## Validation

- Static validation passes and every declared value has one source, classification, destination, and verification signal.
- Re-running completed safe stages is harmless, while irreversible stages require fresh confirmation.

If validation fails, do not hand off the wizard.

## Stop conditions

Stop when official instructions are unavailable, a secret destination is ambiguous, or the procedure cannot be resumed safely after partial failure.

## Refusals

- It does not ask users to paste secrets into chat, logs, arguments, or visible terminal input.
- It does not automate billing, permission grants, deletion, cutover, or other irreversible choices without a human gate.
- It does not claim provider UI steps are current unless they were verified against current official documentation.
