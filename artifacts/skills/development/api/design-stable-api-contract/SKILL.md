---
name: design-stable-api-contract
description: "Design or review an internal, public, HTTP, event, library, or command interface using consumer evidence, invariants, compatibility, error semantics, and evolution rules. Use before implementation or when an interface change could affect independent consumers."
---

# Design Stable API Contract

## Contract

An interface is a dependency promise. Minimize observable behavior deliberately, name consumers and invariants, and treat compatibility as a product decision rather than a serialization detail.

## Shape and challenge the contract

1. Identify consumers, jobs, trust boundary, ownership, latency and scale constraints, current behavior, failure modes, and compatibility window.
2. Model resources or capabilities, operations, inputs, outputs, errors, idempotency, ordering, concurrency, pagination, authentication, versioning, and observability at the right abstraction level.
3. Write examples and counterexamples for normal, empty, malformed, unauthorized, conflicting, repeated, delayed, partial, and deprecated behavior. Remove fields and guarantees without demonstrated consumer need.
4. Review with consumer code or representatives, run contract and compatibility tests, record unresolved tradeoffs, and define change, deprecation, and rollback policy before implementation.

## Validation

- The contract identifies consumers, invariants, ownership, and unsupported behavior.
- Examples and executable checks cover success, failure, boundary, and compatibility paths.
- A change plan explains versioning, migration, observability, and rollback.

## Stop conditions

Stop when consumer ownership, authority, security boundary, existing observable behavior, or compatibility requirements cannot be established.

## Refusals

- It does not invent consumer needs or expose implementation details without a contract reason.
- It does not label a breaking change safe because current tests pass.
- It does not generate credentials, weaken authorization, or deploy interface changes.
