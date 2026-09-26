# schema-compatibility-guard

Compares bounded before-and-after schema structure and blocks removed fields, newly required fields, narrowed JSON types, and reused Protobuf field identities. A Protobuf field may be deleted when its number is reserved in the same message. For Avro, a removed field needs a default and so does a new one. `integer` to `number` in JSON Schema widens the type and is allowed.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not execute schema compilers or resolve remote schema references.
- It does not classify SQL migrations or OpenAPI documents.
- It does not certify compatibility for unsupported schema dialects.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
