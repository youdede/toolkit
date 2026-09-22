---
description: Collect a deterministic redacted environment snapshot before a repository change begins. Use when the named bounded workflow is requested.
allowed-tools: Bash, Read
---

# Preflight Change Environment

## Step 0 — Preconditions (mandatory, deterministic)

Run `node "${CLAUDE_PROJECT_DIR}/.claude/commands/youdede/preflight-change-environment/check-preconditions.mjs"`. On non-zero exit, report the JSON failures and stop. This is the first prompt action, not a pre-invocation parser.

## Step 1 — Collect the redacted snapshot

Run `node "${CLAUDE_PROJECT_DIR}/.claude/commands/youdede/preflight-change-environment/collect-environment.mjs"`. Do not supplement it with environment enumeration.

## Step 2 — Complete the bounded workflow

1. Run the deterministic environment collector after Step 0 and preserve its JSON output verbatim.
2. Compare only declared repository prerequisites with the snapshot; do not enumerate environment variables.
3. Emit **Snapshot**, **Missing prerequisites**, and **Residual uncertainty**.

## Refusals

- Do not print environment-variable names or values, remote URLs, absolute paths, usernames, or file contents.
- Do not install dependencies, change configuration, or repair the environment.
- Do not claim parity with CI or production from a local snapshot.
