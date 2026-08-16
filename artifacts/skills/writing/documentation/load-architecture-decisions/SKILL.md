---
name: load-architecture-decisions
description: "Discover and read all architecture decision records applicable to the current scope, following repository guidance and nested locations. Use before architecture changes or when the user explicitly requests complete ADR context."
---

# Load Architecture Decisions

## Contract

Completeness is a measurable file set, not a claim from sampling. Read every discovered applicable record in full and distinguish accepted, superseded, proposed, and deprecated decisions.

## Workflow

1. Read repository guidance and locate ADR conventions using bounded file search across documented and common decision directories. Record the exact discovered file list before reading.
2. Read each applicable markdown record in full, including status, links, supersession chain, and scope. Follow only directly referenced decision records needed to interpret it.
3. Build a compact map of active constraints, superseded choices, unresolved proposals, contradictions, and implications for the current task. Cite file paths rather than reproducing full ADR text.
4. Compare the proposed work against active decisions. Report missing or malformed records separately and ask before changing architecture or decision status.

## Validation

- The reported ADR count matches the recorded discovered file set.
- Every architectural constraint cites its source record and status.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop and disclose incompleteness when files cannot be read, generated indexes disagree, or the applicable root is ambiguous.

## Refusals

- It does not sample a subset while claiming to have read every ADR.
- It does not treat superseded or proposed records as active policy.
- It does not edit decision status or architecture as part of context loading.
