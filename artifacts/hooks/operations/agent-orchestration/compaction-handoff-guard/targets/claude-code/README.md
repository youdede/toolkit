# compaction-handoff-guard

Install with `npx @youdede/toolkit add compaction-handoff-guard`. The hook observes `PreCompact` and `PostCompact`, then records a bounded receipt at `.claude/youdede-runtime/compaction-handoff.json`. Receipts contain only byte counts and SHA-256 digests; transcript, summary, instruction, and session text are never stored.

The state file is mode `0600`, capped at 256 KiB and 64 hashed session keys, and written atomically without following symlinks. The hook fails open because blocking automatic compaction can terminate a context-limit recovery.

## Refusals and limits

- It does not store transcript, summary, custom-instruction, or session-identifier text.
- It does not block compaction when a transcript or state file is unavailable.
- It does not claim digests demonstrate semantic preservation or summary completeness.
- It does not write outside its exact toolkit-owned project state file.
