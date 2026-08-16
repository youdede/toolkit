---
name: define-revenue-lifecycle
description: "Define or audit the lead-to-revenue lifecycle across marketing, sales, success, billing, and analytics using explicit stage semantics, ownership, service levels, routing, data quality, and reconciliation. Use when handoffs or pipeline reporting are inconsistent."
---

# Define Revenue Lifecycle

## Contract

A stage is a governed business state with entry, exit, owner, and evidence; it is not a dashboard label. Preserve source-system authority and do not automate an undefined process.

## Model the revenue state machine

1. Inventory actors, systems, identifiers, current stages, conversion definitions, timestamps, ownership, routing, exceptions, currencies, contracts, refunds, and reporting disagreements.
2. Define lifecycle states with entry event, required evidence, allowed transitions, owner, service level, exit, recycle, disqualification, reopen, and historical treatment. Separate fit from engagement.
3. Map field authority, synchronization, deduplication, merge, consent, enrichment, error queue, retries, access, retention, and auditability across systems.
4. Test representative and adverse journeys, reconcile stage and revenue totals, set quality monitors, and create a change process for semantics, automation, and reporting.

## Validation

- Each stage has machine-testable entry and exit rules plus a human owner.
- Source-of-truth and synchronization rules exist for every material field and identity.
- Reconciliation explains differences among operational pipeline, contracts, billing, and recognized revenue.

## Stop conditions

Stop when stage authority, identity, consent, contract meaning, source ownership, or production automation permission cannot be resolved.

## Refusals

- It does not silently redefine metrics, overwrite CRM records, or deploy routing automation.
- It does not infer sensitive traits or enrich contacts without an approved purpose and source.
- It does not force incompatible revenue and pipeline definitions to match.
