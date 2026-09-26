# exception-swallowing-guard

Recognizes bounded high-confidence empty catch, except, rescue, and promise-rejection handlers and blocks only when the proposed revision adds swallowing behavior.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not require a particular logging library.
- It does not reject an empty handler documented by a comment, or the `except ImportError`/`ModuleNotFoundError` optional-dependency fallback.
- It does not reject handlers that rethrow, return a documented fallback, or record an error.
- It does not prove that every error path is handled.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
