---
description: Append a redacted, hash-chained work checkpoint to the session ledger. Use when reaching a meaningful point worth resuming from.
allowed-tools: Bash
---

# Record Work Checkpoint

Persist what a future session needs to resume — redacted, bounded, and chain-linked.

## Step 0 — Preconditions (mandatory, deterministic)

```bash
node "${CLAUDE_PROJECT_DIR}/.claude/commands/youdede/record-work-checkpoint/check-preconditions.mjs"
```

Exit non-zero: stop and report the failed check verbatim.

## Step 1 — Compose the checkpoint

Build a JSON object with only these fields:

- `goal`: one sentence — what the work is trying to achieve.
- `pendingClaims`: claims made but not yet verified, as short strings.
- `decisions`: decisions taken this session that a future session must not silently revisit.
- `touchedFiles`: repository-relative paths only; the bridge rejects the whole entry (`touched-file-unsafe`) if any path is absolute or escapes the repository.

Never include secrets, tokens, file contents, or user data beyond these fields. The bridge redacts secret shapes, but you must not rely on redaction as permission.

## Step 2 — Append through the ledger bridge

```bash
node "${CLAUDE_PROJECT_DIR}/.claude/hooks/youdede/lib/session-ledger.mjs" append --workspace "${CLAUDE_PROJECT_DIR}" <<'YOUDEDE_CHECKPOINT_JSON'
<one valid JSON object serialized on one line>
YOUDEDE_CHECKPOINT_JSON
```

The quoted delimiter is mandatory: checkpoint text is data and must never undergo shell expansion.

Exit non-zero: report the failure verbatim and stop — do not retry with mutated content to force acceptance.

## Step 3 — Report the citation handle

State the appended entry's sequence number and the first 12 characters of its hash, so later claims can cite it.

## Refusals

- Do not store secrets or file contents; redaction is a backstop, not permission.
- Do not modify or delete existing entries; the ledger is append-only.
- Do not append when preconditions fail.
