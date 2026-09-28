# lint-suppression-guard

Compares bounded source revisions and rejects new ESLint, Python, Go, and IDE suppressions that name no rule and new TypeScript `@ts-ignore` or `@ts-nocheck` directives, while allowing directives that name a rule. String literal contents are ignored, so a directive quoted in a string does not count.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not decide whether a named diagnostic is correct.
- It does not block removal or narrowing of an existing suppression.
- It does not govern test skips or focused tests.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
