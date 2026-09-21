---
description: Re-run declared verification commands and compare every completion claim against fresh output. Use before accepting a change as done.
allowed-tools: Read, Grep, Glob, Bash
---

# Verify Claims Against Output

Accept no completion claim that fresh command output does not prove.

## Step 0 — Preconditions (mandatory, deterministic)

```bash
node "${CLAUDE_PROJECT_DIR}/.claude/commands/youdede/verify-claims-against-output/check-preconditions.mjs"
```

- Exit 0: continue.
- Exit non-zero: stop. Report the failed check verbatim from the JSON `failures` list. A dirty worktree means results cannot attribute to a known state; ask the user to commit or stash first.

## Step 1 — Collect the claims

1. Read the change description, task list, or conversation claims being asserted.
2. For each claim, identify the verification command that would prove it (test suite, build, lint, type check). If a claim has no verifiable command, mark it **unverifiable** — do not improvise one.
3. If the user passed `--scope <checks>`, run only those checks and say so in the report.

## Step 2 — Run and hash

1. Run each verification command exactly as declared. No added flags, no changed environment.
2. Record exit code, duration, and a sha256 of combined stdout+stderr for each run.
3. Never rerun to "get a pass": flaky output is reported as flaky, with both hashes.

## Step 3 — Emit the verification report

A table mapping every claim to: verification command, exit code, output hash, verdict (**verified** / **refuted** / **flaky** / **unverifiable**). Close with a **Not verified** section listing everything outside the evidence — an empty section must be stated explicitly.

## Refusals

- Do not approve, merge, or sign off; this report informs a human decision.
- Do not run undeclared commands or modify declared ones.
- Do not start when preconditions fail.
