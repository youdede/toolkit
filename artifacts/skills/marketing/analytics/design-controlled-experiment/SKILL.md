---
name: design-controlled-experiment
description: "Design a controlled product or marketing experiment with a falsifiable hypothesis, primary metric, guardrails, exposure plan, and decision rule. Use when a team is comparing variants or needs a defensible experiment rather than an informal before-and-after check."
---

# Design Controlled Experiment

## Contract

Begin with the decision the result will change. Preserve causal interpretability: one declared treatment, one assignment unit, one primary outcome, and no retrospective success criteria.

## Frame, run, and decide

1. Write the decision, target population, baseline, expected mechanism, and a hypothesis that can be disproved. Reject a test whose possible outcomes lead to the same action.
2. Choose assignment and analysis units, primary metric, guardrails, minimum detectable effect, and fixed or sequential stopping rule. Record novelty, interference, seasonality, and instrumentation risks.
3. Define a preflight that verifies assignment, exposure, and event quality with synthetic, internal, or otherwise authorized traffic. A design request produces the launch checklist only. Do not expose users to a treatment until an accountable owner separately authorizes the treatment, population, duration or stopping rule, guardrails, and rollback.
4. Analyze supplied or authorized experiment data against the declared rule, report effect size and uncertainty, check guardrail harm and segment consistency, then recommend ship, iterate, reject, or extend with a new hypothesis. Do not launch, stop, or ship the experiment merely because the analysis recommends it.

## Validation

- The experiment brief fixes hypothesis, units, metrics, exposure, duration logic, and decision thresholds before launch.
- A preflight proves assignment, exposure, and outcome events on both variants.
- The readout includes effect size, uncertainty, guardrails, deviations, and the resulting decision.

## Stop conditions

Stop when assignment cannot be isolated, the primary event is unreliable, the sample cannot support the intended decision, or running the treatment would create unapproved user harm. Stop before live exposure when launch ownership, rollback authority, or treatment approval is unresolved.

## Refusals

- It does not promise significance, lift, or a required sample from invented baseline data.
- It does not peek repeatedly and declare a winner without an approved sequential method.
- It does not hide negative segments, guardrail damage, instrumentation changes, or protocol deviations.
