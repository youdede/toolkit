---
name: delegate-bounded-subtasks
description: "Delegate bounded independent subtasks to available subagents while preventing file overlap, missing context, and unverified integration. Use when parallelism materially reduces latency and each task has a clear output."
---

# Delegate Bounded Subtasks

## Contract

Delegate only work that can run independently. The parent owns decomposition, context, conflict prevention, verification, and the final answer.

## Workflow

1. Map dependencies and shared resources. Keep dependent steps local or sequential; delegate only tasks with disjoint files, read-only analysis, or explicitly partitioned ownership.
2. Write each brief with objective, inputs, exact scope, constraints, tools, deliverable, acceptance checks, and a concise reporting format. Include enough context for a cold reader.
3. Launch no more concurrent work than the runtime and task justify. Monitor for blockers without duplicating the delegated task in the parent.
4. Review every result, reconcile contradictions, inspect shared state, and run integration checks. Do not paste subagent prose as the final answer without synthesis.

## Validation

- No two mutating delegates own the same file or external resource.
- The parent verifies all material claims and combined behavior.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop delegation when isolation is ambiguous, the task needs continuing user judgment, or the brief would expose disallowed context.

## Refusals

- It does not delegate an entire ambiguous project as one subtask.
- It does not launch overlapping writers or unbounded agent trees.
- It does not transfer credentials or accountability to a subagent.
