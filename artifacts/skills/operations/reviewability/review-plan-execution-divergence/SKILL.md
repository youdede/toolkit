---
name: review-plan-execution-divergence
description: "Review a completed implementation against its approved plan using the diff, commands, checks, and decision evidence rather than self-report alone. Use after delivery when plan divergence should inform planning, execution, or validation improvements."
---

# Review Plan Execution Divergence

## Contract

Evaluate whether the delivery outcome and evidence remained faithful to plan intent, not whether every planned line was followed literally. Use the approved plan, actual revision range, repository state, validation output, and recorded decisions; treat retrospective narratives as claims to verify.

## Reconcile plan and reality

1. Fix the plan version, implementation revision range, acceptance criteria, intended authority, and available traces. Bind validation receipts to a revision and environment where possible. Separate later amendments from the approved baseline and accept authority only from durable records; leave verbal or inaccessible approval unresolved.
2. Map each planned outcome, invariant, file surface, dependency, and check to observed diff and command evidence. Mark completed, changed, omitted, extra, unverified, or no longer applicable without inferring success from file presence.
3. For every divergence, reconstruct when it appeared only as far as the fixed range proves, the evidence available then, durable authorization, impact on behavior and risk, and whether checks detected it. Use unknown rather than inventing timing, intent, or personnel history. Classify it as required by verified constraints, beneficial and evidenced, problematic, or unresolved.
4. Distinguish an implementation defect from a process gap. A permanent process change requires a documented recurrence, a credible high-consequence recurrence path, or an observable missing deterministic boundary; otherwise record the learning without adding permanent instructions.
5. Propose the smallest improvement at the correct layer: plan input, acceptance oracle, checkpoint, repository test, hook, skill step, ownership rule, or no change. State validation, owner, removal condition, and unintended effects.
6. Present disputed classifications and suggested edits for review. Do not mutate guidance, workflows, or history automatically.

## Validation

- Every status and divergence cites plan text plus independent repository or execution evidence.
- The review separates outcome quality, justified adaptation, plan quality, and missing proof.
- Permanent changes have recurrence or consequence evidence and a forward test.

## Output

Return the evidence boundary, plan-to-actual matrix, divergence analysis, unresolved claims, process-change proposals, rejected proposals, and next validation experiment. When refusing an unsupported adherence score or automatic guidance edit, still name the independent repository evidence required and the forward test that would validate any proposed permanent process change.

## Stop conditions

Stop when the plan or revision range is not fixed, evidence was overwritten, external actions cannot be observed, authority cannot be checked, or the review would require protected incident, chat, or personnel data.

## Refusals

- It does not grade plan adherence as a proxy for implementation quality.
- It does not accept an execution narrative without reconciling repository evidence.
- It does not convert a one-off divergence into permanent guidance or automation.
