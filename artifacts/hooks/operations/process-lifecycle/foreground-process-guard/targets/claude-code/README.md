# foreground-process-guard

Classifies bounded static shell commands and stops common servers, watchers, and follow-mode tools unless a timeout, detached session, or explicit background boundary is present.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not kill existing processes or manage process supervisors.
- It does not block bounded one-shot build and test commands.
- It does not execute dynamic shell content to discover its duration.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
