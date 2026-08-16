---
name: reconcile-marketing-attribution
description: "Reconcile marketing attribution across analytics, advertising, CRM, billing, self-reported, and experimental evidence. Use when dashboards disagree or a budget decision needs a transparent view of identity gaps, model assumptions, and incrementality."
---

# Reconcile Marketing Attribution

## Contract

Attribution allocates observed credit; it does not by itself prove causation. Define the decision, population, time basis, identity rules, and source authority before comparing numbers.

## Build the reconciliation ledger

1. Inventory systems, conversion definitions, timestamps, lookback windows, currencies, identity keys, consent states, channel taxonomies, and known missing paths.
2. Create a common grain and reconciliation table. Quantify differences caused by scope, model, latency, deduplication, view-through credit, offline events, refunds, and unmatched identities.
3. Compare directional evidence from touch models, self-report, cohort behavior, experiments, and media-mix analysis at an appropriate aggregation level. Label causal and non-causal claims.
4. Recommend decisions with ranges and sensitivity cases, then specify instrumentation or experiments that would reduce the most consequential uncertainty.

## Validation

- Source totals reconcile to documented deltas rather than being forced to match.
- Every reported channel number names its model, window, population, and update time.
- Recommendations show how they change under plausible identity, lag, and incrementality assumptions.

## Stop conditions

Stop when definitions cannot be aligned, source exports are incomplete, identity joins violate policy, or the requested causal conclusion exceeds the available design.

## Refusals

- It does not select the most favorable dashboard or silently merge incompatible conversion definitions.
- It does not expose individual journeys or bypass consent to close identity gaps.
- It does not call attributed revenue incremental revenue without experimental or model-based causal support.
