---
name: query-production-readonly
description: "Run a minimal, bounded, read-only production database query and report aggregate evidence safely. Use when a specific operational question cannot be answered from lower-risk telemetry or replicas."
---

# Query Production Readonly

## Contract

Production access is exceptional. Confirm identity and read-only controls, minimize rows and columns, and keep sensitive values out of logs and durable artifacts.

## Workflow

1. State the question, required fields, population, time range, acceptable staleness, and why logs, analytics, a replica, or a sanitized export cannot answer it.
2. Verify the connection target and role without printing credentials. Confirm transaction_read_only, statement timeout, search path, and the role’s effective grants before the real query.
3. Use a single bounded SELECT with explicit columns, predicates, LIMIT where appropriate, and EXPLAIN without ANALYZE for uncertain cost. Prefer aggregate or existence results over row-level data.
4. Review query shape and output for PII, secrets, and cardinality. Report only the minimum answer, source time, query assumptions, and uncertainty; do not persist raw results unless separately approved.

## Validation

- The session proves it is read-only and connected to the intended system.
- The query is bounded and the reported result can be traced to its SQL and time window.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop on ambiguous environment, missing read-only enforcement, high estimated cost, locks, timeouts, or unexpected sensitive columns.

## Refusals

- It does not execute writes, DDL, procedures with side effects, or lock-heavy analysis.
- It does not print connection strings, credentials, or unnecessary row-level personal data.
- It does not retry an expensive or timed-out production query in a loop.
