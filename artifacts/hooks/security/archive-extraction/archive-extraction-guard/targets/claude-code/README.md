# Archive extraction guard for Claude Code

This project-scoped `PreToolUse` hook allows archive listing and integrity checks but blocks actual TAR, ZIP, and 7-Zip extraction from Bash. The conservative boundary is intentional: the standalone hook has no external archive parser, so it cannot prove that every entry, link target, and expansion size stays inside the destination before the extraction tool runs.

The policy core is the exported pure `evaluate(input)` function. It recognizes direct and common wrapped commands, has bounded input, and never includes submitted command text in diagnostics.

## Refusals and limits

- The hook does not extract, rewrite, repair, quarantine, or delete archives.
- It does not claim that listing filenames proves link containment or decompression safety.
- It does not inspect proprietary archive formats or encrypted archive contents.
- It does not accept comments, flags, prompts, or environment variables as approval.
