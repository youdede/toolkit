# Session continuity

Persist bounded hash-chained checkpoints, restore cited context, and verify continuity across sessions.

## What it contains

- **Record Work Checkpoint** (command): Append a redacted, hash-chained work checkpoint to the session ledger with a verified git anchor.
- **Verify Session Ledger** (command): Verify the hash-chained session ledger and report exactly which entries, if any, fail integrity.
- **Compact Readiness Guard** (hook): Warn before compaction when uncommitted changes or pending ledger claims would silently lose context.
- **Session Checkpoint Guard** (hook): Append a deterministic, hash-chained session-end receipt to the local session ledger.
- **Session Restore Guard** (hook): Inject a bounded, integrity-flagged summary of the latest session-ledger checkpoints at session start.
- **Resume Session Work** (skill): Reconstruct working context from the hash-chained session ledger with hash-cited claims and an explicit unverified section.
- **Decision Record Reviewer** (subagent): Review a bounded decision record for evidence, alternatives, tradeoffs, consequences, and revisit triggers.

## What it runs

Hooks run local Node.js scripts from `hooks/youdede/` on the tool calls and session events they declare. They make no network requests. Some run local `git` commands to read repository state.

Every member states what it refuses to do. Read each file before you install it.

Source and evidence: https://github.com/youdede/toolkit/blob/main/packs/session-continuity/pack.json

License: MIT. See `LICENSE` and `NOTICE`.
