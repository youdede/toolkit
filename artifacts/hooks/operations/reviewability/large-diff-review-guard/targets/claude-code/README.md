# Large diff review guard for Claude Code

This hook treats reviewability as a bounded measurable property. It checks staged file, line, and binary-byte totals only when a Git commit is attempted.

The fixed limits are 50 files, 1,200 changed text lines, 5 MiB for one binary, and 20 MiB across staged binaries.

Rename similarity and semantic complexity are not estimated. The hook does not accept repository configuration or command flags as a bypass.

## Refusals

- It does not split, edit, stage, unstage, commit, summarize, review, or approve the change.
- It does not claim that a small diff is correct or that a large diff is necessarily unsafe.
- It does not inspect unstaged work or count generated impact outside the staged snapshot.
- It does not accept repository configuration, commit flags, or prompt text as a bypass.
