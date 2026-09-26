---
name: resume-session-work
description: Reconstruct working context from the hash-chained session ledger, citing entry hashes for every claim carried forward. Use when resuming work after a break, a compaction, or a new session on an in-flight task.
---

# Load Session Context

Rebuild trustable working context from `.youdede/session-ledger.jsonl` — never from memory of a summary.

## Step 1 — Verify before trusting

Run the ledger verification:

```bash
node "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.claude/hooks/youdede/lib/session-ledger.mjs" verify --workspace "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
```

(If the command artifacts are installed, `/verify-session-ledger` does the same with explanation.)

- Chain verified: proceed.
- Chain failure: tell the user which line fails, treat every ledger claim as unverified, and ask whether to continue from the last intact entry.

## Step 2 — Read the tail

```bash
node "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/.claude/hooks/youdede/lib/session-ledger.mjs" tail --workspace "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" --n 5
```

## Step 3 — Reconstruct with citations

For every claim you carry forward (goal, pending claim, decision), cite the 12-character entry hash it came from. Then check each pending claim against the current worktree before treating it as still open — a claim about a file that has since changed is stale, say so.

## Step 4 — State what could not be verified

Close with a **Could not verify** section: entries missing, claims stale, git anchors that no longer match HEAD. An empty section must be stated explicitly.

## Refusals

- Do not treat a tampered or unverifiable chain as ground truth.
- Do not carry forward a claim without its ledger entry hash.
- Do not rewrite or "repair" the ledger; it is append-only, and corruption is reported, not fixed.
- Do not claim the local chain proves authorship; an actor with write access to both ledger and head seal is outside its threat model.
