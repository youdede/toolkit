---
name: surface-build-decisions
description: "Identify the smallest set of consequential product and technical decisions that should be made before building. Use when a plan appears ready but hidden defaults could create rework or irreversible behavior."
---

# Surface Build Decisions

## Contract

Focus on decisions that are expensive to reverse or materially change user behavior. Provide evidence, options, and a recommendation without pretending every detail needs advance approval.

## Workflow

1. Review requirements, repository conventions, existing architecture decisions, constraints, and the proposed plan. Identify where the plan silently chooses behavior or ownership.
2. Rank decisions by user impact, security, data migration, external compatibility, operational burden, and reversibility. Drop low-impact implementation details.
3. For each top decision, state the question, two or three credible options, tradeoffs, evidence, recommended default, and consequence of deferring it.
4. Resolve only the highest-impact open choice at a time. Record accepted decisions in the project’s canonical plan or ADR location and mark assumptions explicitly.

## Validation

- Every surfaced choice has materially different consequences.
- Recorded decisions include rationale and do not conflict with existing project policy.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop when the next choice is easily reversible and implementation evidence is more valuable than further discussion.

## Refusals

- It does not manufacture decisions merely to appear thorough.
- It does not reopen settled choices without new contradictory evidence.
- It does not treat a recommendation as approval.
