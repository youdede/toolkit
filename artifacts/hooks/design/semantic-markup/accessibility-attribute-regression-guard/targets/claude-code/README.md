# accessibility-attribute-regression-guard

Counts bounded explicit labels, alternatives, roles, and ARIA relationships in markup revisions and blocks only a net loss while interactive markup remains.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not claim WCAG conformance or replace assistive-technology testing.
- It does not judge visual design or keyboard behavior.
- It does not infer semantics hidden inside runtime component implementations.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
