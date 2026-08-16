---
name: provision-postgres-readonly-role
description: "Prepare reviewed PostgreSQL SQL for a login role that defaults to read-only, has bounded execution, and excludes sensitive relations. Use when humans need to grant an analyst or agent production read access."
---

# Provision Postgres Readonly Role

## Contract

Generate auditable SQL and a verification plan; do not apply production grants unless the user explicitly authorizes execution. Prefer explicit schema and relation grants over broad future access.

## Workflow

1. Inventory databases, schemas, relation types, ownership, RLS policies, sensitive tables, and required queries with an existing administrator. Define an allowlist and expiration or review date.
2. Create a NOINHERIT or otherwise deliberately composed login role with default_transaction_read_only, statement timeout, idle timeout, and connection limit. Do not grant superuser, role creation, replication, or bypass RLS.
3. Grant CONNECT, USAGE, and SELECT only to required objects. Treat default privileges as a separate reviewed decision because they silently grant access to future tables.
4. Test as the role: allowed SELECT succeeds; INSERT, UPDATE, DELETE, DDL, COPY to server files, sensitive tables, and other schemas fail. Record revocation SQL alongside creation SQL.

## Validation

- Privilege inspection matches the allowlist and future-object policy.
- Positive and negative queries are executed as the new role.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop when RLS behavior, sensitive-table classification, ownership, or production execution authority is unclear.

## Refusals

- It does not grant SUPERUSER, BYPASSRLS, write privileges, or role administration.
- It does not embed or print a production password.
- It does not apply production DDL without explicit authorization and a revocation plan.
