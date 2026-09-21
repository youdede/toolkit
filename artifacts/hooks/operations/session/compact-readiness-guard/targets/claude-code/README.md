# compact-readiness-guard

Before compaction, counts uncommitted worktree changes and reads pending claims from the latest ledger checkpoint, then emits a bounded system warning when either exists. It complements the `compaction-handoff-guard` receipts: one records that compaction happened, this one warns what compaction would hide.

The hook always exits 0; compaction is never blocked.

## Refusals and limits

- It does not block, delay, or alter compaction.
- It does not inspect transcript content; only git state and the ledger tail.
- It does not treat missing git or ledger data as an error; it degrades to no warning.
- It does not echo more than 300 characters of pending claims.
