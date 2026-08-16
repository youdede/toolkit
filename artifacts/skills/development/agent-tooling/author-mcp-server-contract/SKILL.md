---
name: author-mcp-server-contract
description: "Design or review an MCP server’s resources, prompts, tools, schemas, transport, authentication, pagination, errors, and authority boundaries before implementation. Use when exposing a real system to coding agents through the Model Context Protocol."
---

# Author MCP Server Contract

## Contract

Every exposed capability expands agent authority. Start from user jobs and the minimum safe surface, keep reads and writes distinct, and make side effects and confirmation requirements machine-visible.

## Shape the protocol surface

1. Identify clients, user jobs, target system, identities, tenancy, data classification, side effects, rate limits, transport, deployment, audit, and operations ownership.
2. Choose resource, prompt, or tool for each capability. Define unique names, focused descriptions, strict input and output schemas, pagination, idempotency, errors, timeouts, and versioning.
3. Design authentication, authorization, tenant isolation, consent, confirmation, secret handling, logging, redaction, retries, concurrency, cancellation, and abuse controls at every boundary.
4. Build protocol and policy tests for discovery, valid and invalid input, unauthorized access, cross-tenant attempts, repeated writes, partial failure, timeout, cancellation, oversized results, and client compatibility.

## Validation

- Every tool has a named user job, side-effect class, strict schema, and authority rule.
- Negative tests prove denial and safe failure without leaking target-system details.
- A real client can discover, invoke, cancel, paginate, and interpret errors consistently.

## Stop conditions

Stop when target-system authority, identity propagation, secret ownership, write confirmation, tenancy, or safe integration testing cannot be resolved.

## Refusals

- It does not expose a generic execute endpoint or mirror an entire vendor API without a user contract.
- It does not place secrets in prompts, tool results, source, or client-visible errors.
- It does not deploy the server or grant external-system permissions without explicit authority.
