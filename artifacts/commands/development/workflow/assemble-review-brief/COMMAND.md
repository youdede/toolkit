---
description: Assemble a review brief from the real diff with scope, risks, and test evidence. Use when preparing a change for human review.
allowed-tools: Read, Grep, Glob, Bash
---

# Assemble Review Brief

Prepare a brief that lets a reviewer check every claim against the actual change.

## Step 0 — Preconditions (mandatory, deterministic)

```bash
node "${CLAUDE_PROJECT_DIR}/.claude/commands/youdede/assemble-review-brief/check-preconditions.mjs"
```

- Exit 0: continue.
- Exit non-zero: stop and report the failed check verbatim.

## Step 1 — Bound the change

1. Identify the diff: staged changes, a named commit range, or `--scope <paths>` if the user supplied one.
2. If no diff exists, say so and stop — do not assemble a brief from intentions.

## Step 2 — Map risk and evidence

For each changed area:

- **What changed**: one sentence, anchored to file paths and symbols you actually read.
- **Risk**: what breaks if this is wrong, and who notices first.
- **Evidence**: the tests, checks, or output that cover this area — or the explicit label **uncovered**.
- **Reviewer focus**: the lines where a mistake would hide best.

## Step 3 — Emit the brief

Sections: *Scope* (diffstat and commit range), *Areas* (the Step 2 map), *Uncovered and unverified* (mandatory, may be declared empty), *Suggested review order*. Keep it readable in five minutes; link, do not paste, long outputs.

## Refusals

- Do not approve or request changes; the brief informs a human reviewer.
- Do not describe files or diff ranges you have not inspected.
- Do not omit unverifiable areas; list them.
