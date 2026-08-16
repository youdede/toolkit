# unsafe-deserialization-guard

Scans bounded proposed source content after masking comments and quoted text, then blocks net-new calls to known unsafe deserializers across common languages.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not deserialize supplied data or execute parser code.
- It does not replace a threat model for custom protocols.
- It does not treat safe parser names inside documentation as executable calls.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
