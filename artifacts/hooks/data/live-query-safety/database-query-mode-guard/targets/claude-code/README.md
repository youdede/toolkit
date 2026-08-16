# database-query-mode-guard

Extracts bounded SQL from recognized CLI flags or structured query fields, masks comments and literals, and permits only read-oriented statement forms at a live execution boundary.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not inspect migration files or database schema changes.
- It does not connect to a database or execute EXPLAIN.
- It does not treat stored procedures as read-only without an explicit static contract.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
