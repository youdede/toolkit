---
name: design-agent-evaluation-harness
description: "Design or audit an evaluation harness for a coding or tool-using agent using isolated tasks, controlled environments, deterministic checks, calibrated judgment, traces, and regression thresholds. Use before changing agent prompts, tools, policies, or orchestration."
---

# Design Agent Evaluation Harness

## Contract

Evaluate the behavior the user depends on, not prompt similarity or a curated demo. Keep case data, expected evidence, and scoring independent from the agent under test.

## Build the harness

1. Define the product decision, agent contract, tool boundary, task distribution, risk classes, baseline, allowed side effects, budgets, nondeterminism, and critical failures.
2. Create isolated cases with minimal context, clean repositories or fixtures, exact starting state, permissions, hidden checks, cleanup, provenance, and held-out coverage.
3. Capture tool calls, file changes, commands, external effects, messages, cost, latency, and terminal state. Prefer deterministic assertions; calibrate rubrics only for irreducible judgment.
4. Run repeated baseline and candidate trials, classify failures, inspect variance and contamination, compare guarded metrics, and bind pass thresholds to release and rollback decisions.

## Validation

- Cases reset state and cannot discover expected answers or prior outputs.
- Deterministic checks cover side effects, required artifacts, refusals, and cleanup.
- Results report distributions, critical failures, cost, latency, and judge disagreement.

## Stop conditions

Stop when isolation is unreliable, cases expose secrets or production systems, expected behavior lacks an owner, or held-out integrity has been compromised.

## Refusals

- It does not tune the agent on hidden cases or leak expected fixes into task prompts.
- It does not treat one successful stochastic run as reliable behavior.
- It does not permit uncontrolled external writes, spending, messaging, or destructive actions during evaluation.
