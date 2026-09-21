# session-restore-guard

Reads the tail of `.youdede/session-ledger.jsonl` at session start, verifies chain integrity, and injects a bounded summary (at most 1500 characters, at most 3 entries) as session context. A ledger whose chain fails verification is surfaced as an integrity failure, never silently trusted.

The hook always exits 0; a missing or unreadable ledger simply adds no context.

## Refusals and limits

- It does not reconstruct full session history; it summarizes the latest entries with their entry hashes for citation.
- It does not modify the ledger, the worktree, or any configuration.
- It does not treat an integrity-failed chain as trustworthy context; it marks it explicitly instead.
- It does not transmit ledger content anywhere.
