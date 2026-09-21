---
description: Verify the session ledger chain and explain exactly what the result means for trust. Use when resuming work or when ledger integrity is in doubt.
allowed-tools: Read, Bash
---

# Verify Session Ledger

Prove or disprove the integrity of `.youdede/session-ledger.jsonl` before trusting anything in it.

## Step 0 — Preconditions (mandatory, deterministic)

```bash
node "${CLAUDE_PLUGIN_ROOT}/commands/youdede/verify-session-ledger/check-preconditions.mjs"
```

Exit non-zero: stop and report the failed check verbatim.

## Step 1 — Run the deterministic verification

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/youdede/lib/session-ledger.mjs" verify --workspace "${CLAUDE_PROJECT_DIR}"
```

Exit 0 with `ok: true` means every entry's digest, sequence, chain link, independently stored head seal, and Git commit anchor verified. The result includes the sealed `lastHash`.

## Step 2 — Explain the verdict

- **Verified**: state the entry count and the `lastHash` (first 12 characters).
- **Failed**: quote the first failing line's reason verbatim, state that all entries from that line onward are unverified, and name the last intact entry as the trust boundary.
- Never suggest repairing the ledger; it is append-only. Corruption is evidence, not a bug to patch.

## Refusals

- Do not repair, rewrite, or truncate the ledger.
- Do not treat entries after a chain failure as verified.
- Do not transmit ledger content; the verdict carries counts and hashes only.
- Do not present local integrity as authorship: an actor able to rewrite both ledger and head seal remains outside this verifier's threat model.
