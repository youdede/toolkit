# subagent-fanout-guard

Counts prior Task and Agent tool calls in the supplied Claude Code transcript and blocks delegation after a fixed conservative session budget without invoking a model.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not decide which specialist should be delegated to.
- It does not infer concurrency or nesting when the transcript does not encode it.
- It does not edit transcripts or terminate already running agents.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
