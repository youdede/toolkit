# api-contract-compatibility-guard

Compares OpenAPI JSON or indentation-stable YAML signatures and blocks removed routes, operations, response codes, and newly mandatory parameters without executing generators.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not call an API or regenerate clients.
- It does not infer undocumented consumer behavior.
- It does not approve a breaking-version release.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
