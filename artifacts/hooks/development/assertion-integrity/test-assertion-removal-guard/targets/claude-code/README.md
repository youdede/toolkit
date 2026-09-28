# test-assertion-removal-guard

Compares bounded test-file revisions and stops a change when a test that stays in the file loses every recognizable assertion or failure primitive. Test files are those under `test`/`tests`/`spec`/`specs`, those named `*.test.*`, `*.spec.*`, `*_test.*`, or `*_spec.*`, and pytest's `test_*.py`.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not judge assertion quality or test coverage.
- It does not block assertion-preserving refactors recognized by its bounded vocabulary.
- It does not govern skipped or deleted test cases.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
