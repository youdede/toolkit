# failure-evidence-guard

Install with `npx @youdede/toolkit add failure-evidence-guard`. The hook observes `PostToolUseFailure`, classifies a bounded error using stable fields, and adds a short receipt to model context. It never copies raw commands, inputs, stack traces, or error text.

This is an observer, not an enforcement gate. Malformed and oversized input fail open, and the original Claude Code failure remains authoritative.

## Refusals and limits

- It does not retry, repair, rerun, or alter a failed tool call.
- It does not expose raw command, tool input, stack trace, or error content.
- It does not treat a deterministic category as proof of root cause.
- It does not block subsequent work when normalization is unavailable.
