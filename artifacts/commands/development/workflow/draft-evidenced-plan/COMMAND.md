---
description: Draft an ordered implementation plan where every step cites concrete files and its verification command. Use when the user asks for a plan before implementation.
allowed-tools: Read, Grep, Glob
---

# Draft Evidenced Plan

Produce an implementation plan whose claims are anchored to code you have actually read.

## Step 0 — Preconditions (mandatory, deterministic)

Before anything else, run:

```bash
node "${CLAUDE_PROJECT_DIR}/.claude/commands/youdede/draft-evidenced-plan/check-preconditions.mjs"
```

- Exit 0: continue.
- Exit non-zero: stop. Report the failed check verbatim from the JSON `failures` list and do not plan.

## Step 1 — Read before planning

1. Use Glob and Grep to locate the surfaces the request touches; use Read on every file a planned step will modify.
2. If the user passed `--scope <paths>`, restrict all reading and all planned edits to those paths.
3. Record what you could not inspect; never plan around an unread file silently.

## Step 2 — Emit the plan

Write the plan as a numbered list. Every step must contain:

- **Change**: what will be edited, one sentence.
- **Files**: concrete paths you read in Step 1.
- **Verification**: the exact command whose passing proves this step done (test, build, lint, or a named manual check when no command exists).
- **Rollback**: how the step is undone if its verification fails after merge.

Close with an **Open questions** section listing every decision the repository evidence could not settle. If that section is empty, say so explicitly.

## Refusals

- Do not edit, create, or delete any file while planning.
- Do not estimate effort, and do not invent verification for code you have not read.
- Do not proceed past failed preconditions, and do not widen beyond a user-supplied `--scope`.
