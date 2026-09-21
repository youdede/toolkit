# session-checkpoint-guard

Appends a deterministic session-end receipt to the hash-chained ledger at `.youdede/session-ledger.jsonl`: timestamp, event reason, sequence number, previous-entry digest, and a git anchor (HEAD, branch, dirty-set hash). It records only what the event itself proves.

The hook reads at most 1 MiB from stdin, writes only inside `.youdede/`, applies secret redaction before any write, and always exits 0 — a receipt must never block a session from ending.

## Refusals and limits

- It does not infer goals, claims, or decisions; rich checkpoints belong to the `record-work-checkpoint` command.
- It does not block, delay, or alter the session-end event under any circumstance.
- It does not transmit, upload, or share ledger content; the file stays local with owner-only permissions.
- It does not write through a symlinked or otherwise unsafe ledger path.
