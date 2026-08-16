---
name: design-marketing-measurement
description: "Design or audit marketing measurement with decision questions, event semantics, identity boundaries, consent constraints, QA, and ownership. Use when teams need trustworthy conversion tracking or a tracking plan rather than an indiscriminate list of events."
---

# Design Marketing Measurement

## Contract

Collect only data tied to an approved decision and lawful purpose. Define semantics before tools, minimize identifiers, and distinguish observed behavior from inferred identity.

## From questions to governed signals

1. List the decisions, actors, journeys, outcomes, reporting latency, retention needs, and privacy constraints. Remove requests that have no owner or plausible action.
2. Define events and properties in business language with trigger, actor, object, timestamp, source, allowed values, identity state, and explicit exclusions. Version breaking semantic changes.
3. Map collection points across client, server, advertising, CRM, and warehouse boundaries. Specify consent, deduplication, retries, ordering, time zones, bot filtering, and access control.
4. Build a QA matrix with positive, negative, malformed, duplicate, delayed, revoked-consent, and cross-device cases. Assign monitoring, documentation, incident, and deprecation ownership.

## Validation

- Every proposed field supports a named question and has an owner, retention rule, and allowed-value contract.
- Test evidence proves both expected events and prohibited collection paths.
- A reconciliation check connects source events to downstream totals and documents unavoidable differences.

## Stop conditions

Stop when consent, identity ownership, data classification, production access, or the exact business meaning of a conversion is unresolved.

## Refusals

- It does not collect personal or sensitive data merely because a tool supports it.
- It does not invent event semantics from dashboard labels or silently redefine historical metrics.
- It does not claim implementation works without observed payloads and downstream reconciliation.
