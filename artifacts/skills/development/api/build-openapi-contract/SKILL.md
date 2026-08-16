---
name: build-openapi-contract
description: "Build or repair an OpenAPI document by reconciling implementation, tests, product requirements, authentication, schemas, examples, and error behavior. Use when an HTTP API needs an accurate machine-readable contract or drift review."
---

# Build OpenAPI Contract

## Contract

The document describes an agreed API; it may not invent behavior to satisfy a linter. Resolve whether code, tests, or an approved design is authoritative for each conflict.

## Reconcile behavior into the contract

1. Identify API version, servers, consumers, source of truth, routes, authentication, authorization scopes, content types, error model, compatibility, code generation, and publication path.
2. Model operations with stable IDs, parameters, request and response bodies, reusable schemas, constraints, examples, headers, pagination, idempotency, rate limits, callbacks, and documented failures.
3. Validate syntax and references, lint project policy, generate representative clients or mocks when used, and run contract tests against success, malformed, unauthorized, missing, conflict, rate-limit, and server errors.
4. Produce a drift report for implementation and document differences, resolve approved changes, regenerate only through repository tooling, and verify deterministic output and consumer compatibility.

## Validation

- Every operation and schema traces to approved behavior or a documented design decision.
- Validation covers references, examples, security, failure responses, and repository lint rules.
- Contract tests or generated artifacts expose drift at relevant boundaries.

## Stop conditions

Stop when authority among code, tests, and design is unresolved, access semantics are unclear, or generation would overwrite user-owned contract changes.

## Refusals

- It does not invent endpoints, fields, examples, status codes, or security scopes.
- It does not expose internal or sensitive schemas merely because implementation fields exist.
- It does not publish, deploy, or guarantee backward compatibility without evidence.
