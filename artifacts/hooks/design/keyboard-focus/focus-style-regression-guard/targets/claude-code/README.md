# focus-style-regression-guard

Parses bounded CSS rule blocks and rejects net-new focus selectors that disable outlines without a visible outline, shadow, border, or text-decoration replacement.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not evaluate rendered contrast or pixel visibility.
- It does not reject outline removal when the same focus rule supplies a visible replacement.
- It does not claim keyboard accessibility conformance.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
