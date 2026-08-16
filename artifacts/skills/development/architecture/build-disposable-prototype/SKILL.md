---
name: build-disposable-prototype
description: "Build a disposable logic or interface prototype around one explicit uncertainty, with observable state, representative scenarios, and a removal decision. Use when cheap interaction evidence is more useful than further abstract discussion."
---

# Build Disposable Prototype

## Contract

A prototype answers one named question; it is evidence, not production code. Define its audience, decision, success signal, time budget, disposal path, and forbidden dependencies before building.

## Workflow

1. Phrase the uncertainty as a falsifiable question. Choose a logic probe for state and rules, an interaction probe for user flow and presentation, or a technical spike for feasibility. Do not mix branches unless one decision genuinely requires both.
2. Reuse the repository's runtime and conventions only where that shortens execution. Mark every route, file, dataset, and credential scope as disposable; use memory or isolated synthetic data by default.
3. Implement the smallest runnable surface. Expose relevant state and transitions, include ordinary, boundary, failure, and recovery scenarios, and give the reviewer one command or file to open.
4. Observe the intended reviewer using the prototype or run the agreed probes. Record evidence separately from interpretation and identify which decision the result supports, rejects, or leaves open.
5. Transfer only the validated decision into the durable specification. Delete the prototype, isolate it on a non-production branch, or explicitly promote it through normal engineering checks.

## Validation

- The artifact can answer the original question without relying on unapproved external state.
- The handoff records verdict, evidence, limitations, owner decision, and exact disposal status.

If validation fails, narrow the question or build a cheaper observable probe.

## Stop conditions

Stop when the question is undefined, the prototype would touch production data, or stakeholders could mistake it for supported production behavior.

## Refusals

- It does not add production credentials, durable migrations, analytics, or infrastructure for a disposable experiment.
- It does not claim usability, feasibility, or correctness from the author's own walkthrough alone.
- It does not leave prototype code on the main delivery path without an explicit promotion decision.
