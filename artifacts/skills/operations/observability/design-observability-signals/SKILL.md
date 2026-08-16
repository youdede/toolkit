---
name: design-observability-signals
description: "Design or audit observability for a service, job, client, or distributed flow using operational questions, failure modes, structured events, metrics, traces, alerts, retention, and privacy. Use before implementation or when operators cannot explain system behavior safely."
---

# Design Observability Signals

## Contract

Signals exist to support an operational decision. Collect the minimum context needed to distinguish failure states without leaking secrets, personal data, or unbounded cardinality.

## Map questions to signals

1. Identify service objectives, operators, critical journeys, dependencies, failure modes, deployment boundaries, incident questions, data sensitivity, and cost constraints.
2. For each question choose logs, metrics, traces, profiles, audits, or synthetic checks. Define names, units, labels, sampling, correlation, ownership, retention, and redaction.
3. Design dashboards and alerts from symptoms and actionable thresholds. Include missing telemetry, partial outage, backpressure, dependency, retry storm, clock, queue, and saturation cases.
4. Instrument the narrowest useful path, test signal emission and absence, force safe failures, verify correlation and redaction, estimate cost and cardinality, and document runbook links.

## Validation

- Every signal and alert maps to an operator question and owner.
- Tests prove expected, failed, sampled, redacted, and telemetry-unavailable behavior.
- Cardinality, volume, retention, access, and cost are bounded.

## Stop conditions

Stop when sensitive-data classification, signal ownership, cost limits, incident actions, or production access and rollout authority are unresolved.

## Refusals

- It does not log secrets, raw customer payloads, or unnecessary identifiers.
- It does not alert on non-actionable noise or use dashboard presence as proof of observability.
- It does not deploy instrumentation or change retention without authorization.
