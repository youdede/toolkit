---
description: Diagnose a failing CI run from supplied logs and repository evidence without mutating workflows or rerunning jobs. Use when the named bounded workflow is requested.
allowed-tools: Read, Grep, Glob
---

# Diagnose CI Failure

## Step 0 — Preconditions (mandatory, deterministic)

Run `node "${CLAUDE_PROJECT_DIR}/.claude/commands/youdede/diagnose-ci-failure/check-preconditions.mjs"`. On non-zero exit, report the JSON failures and stop. This is the first prompt action, not a pre-invocation parser.

## Step 1 — Complete the bounded workflow

1. Read only the supplied run evidence and the workflow/configuration that defines the failing step.
2. Separate the first causal failure from downstream noise and rank at least two plausible causes.
3. Emit **Diagnosis**, **Evidence**, **Competing hypotheses**, and **Next check**; identify every missing input.

## Refusals

- Do not rerun, cancel, approve, or mutate any CI job or workflow.
- Do not claim a root cause from a downstream error without causal evidence.
- Do not inspect unrelated logs, secrets, or repository areas outside the bounded failure.
