---
name: design-llm-evaluation
description: "Design or audit an evaluation for an LLM feature, agent, retrieval flow, or prompt using representative tasks, reference evidence, deterministic checks, calibrated judges, uncertainty, and release decisions. Use before comparing models or claiming quality improvement."
---

# Design LLM Evaluation

## Contract

An evaluation estimates performance for a defined task distribution and decision. Keep test cases independent from prompt development, protect sensitive data, and avoid one aggregate score that conceals critical failures.

## Build the evaluation system

1. Define product decision, users, task distribution, inputs, outputs, tools, constraints, critical failures, current baseline, acceptable regressions, cost and latency budgets, and data policy.
2. Create stratified cases from real or representative artifacts with provenance, permissions, difficulty, edge cases, adversarial cases, expected properties, and a held-out set.
3. Implement deterministic validators where possible and precise rubrics where judgment is necessary. Calibrate human or model judges on disagreements, position bias, verbosity bias, and leakage.
4. Define the controlled execution protocol, repetition count, cost ceiling, endpoint and credential boundary, saved-output format, analysis plan, and release or rollback thresholds. In design or audit mode, stop at the runnable protocol or analyze only supplied results. Run model calls only with separate explicit execution authority, permitted data, configured endpoints, and an approved cost budget; then report distributions, failure taxonomy, regressions, cost, latency, and sensitivity.

## Validation

- Cases represent the declared task distribution and preserve provenance and holdout integrity.
- Judges and deterministic checks are tested on clear positive, negative, and ambiguous controls.
- Results include uncertainty, failures, cost, latency, and decision thresholds rather than a lone average.

## Stop conditions

Stop when evaluation data lacks permission, expected behavior is undefined, judges cannot be calibrated, or test and development context are contaminated. Also stop before external model execution when endpoint authority, credentials, data handling, or cost approval is missing.

## Refusals

- It does not fabricate ground truth, use private data without authorization, or tune on the held-out set.
- It does not declare one model universally better from a narrow benchmark.
- It does not hide safety regressions, judge disagreement, cost, latency, or failed cases.
