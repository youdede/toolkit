---
name: design-data-quality-controls
description: "Design or audit data-quality controls for datasets, pipelines, metrics, or interfaces using semantic contracts, risk, checks, lineage, ownership, observability, and incident response. Use when downstream decisions require trustworthy structured data."
---

# Design Data Quality Controls

## Contract

Quality is fitness for a named use, not a universal score. Define meaning, grain, freshness, completeness, validity, and reconciliation at each critical boundary before selecting tools.

## Map risks to controls

1. Identify consumers, decisions, entities, grain, sources, transformations, service expectations, regulatory constraints, failure history, and business impact of wrong, late, missing, or duplicated data.
2. Write contracts for schema, semantics, keys, nullability, domains, units, time, ordering, freshness, volume, lineage, and reconciliation. Assign producer and consumer owners.
3. Place preventive, detective, and corrective controls at ingestion, transformation, publication, and consumption. Define thresholds, sampling, quarantine, backfill, alert, override, and audit behavior.
4. Test valid and invalid fixtures, late and duplicate records, schema drift, partial loads, replay, source outages, timezone edges, and reconciliation. Run incidents and tune controls from false positives and missed failures.

## Validation

- Every critical check maps to a consumer risk and named owner.
- Fixtures prove both detection and safe handling, not only query syntax.
- Quality status, lineage, overrides, and incidents remain auditable.

## Stop conditions

Stop when data semantics, authority, sensitive classification, downstream impact, or safe quarantine and recovery behavior cannot be established.

## Refusals

- It does not equate passing schema checks with trustworthy analytical meaning.
- It does not delete, rewrite, quarantine, or backfill production data without authority.
- It does not hide overrides, false positives, or unresolved reconciliation gaps.
