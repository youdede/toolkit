---
name: design-delegable-workflow
description: "Design a recurring workflow for human, deterministic automation, and optional agent work by modeling triggers, state, decisions, authority, checkpoints, failures, and observability. Use before automating a repeated operational loop."
---

# Design Delegable Workflow

## Contract

Model a recurring loop before choosing automation. Assign deterministic work to code, judgment to an agent only where bounded, and authority-sensitive decisions to a human. Scheduling is optional and never implied.

## Workflow

1. Observe at least one real run or reconstruct it from artifacts. Define trigger, inputs, preconditions, states, transitions, outputs, owner, frequency, volume, service expectations, and current failure handling.
2. Separate lookup, parsing, validation, routing, and invariant enforcement that can be deterministic from synthesis or classification that needs judgment. Define fallbacks when agent confidence or evidence is insufficient.
3. For every action, record identity, permissions, data classes, idempotency key, retry budget, timeout, cost ceiling, audit event, and compensation. Put checkpoints immediately before the smallest irreversible or externally visible action.
4. Design the late human brief: decision requested, work already completed, evidence, alternatives, risk, and direct artifact links. Do not ask a reviewer to rediscover raw context.
5. Specify positive, malformed, duplicate, partial-failure, stale-state, concurrency, and recovery runs. Define rollout, shadow mode where useful, success measures, disable switch, and owner.

## Validation

- Every state transition has one actor, authority rule, idempotency behavior, evidence event, and failure destination.
- Deterministic steps remain useful without an AI runtime, and judgment steps have an explicit uncertainty fallback.

If validation fails, keep the workflow manual and capture another real run.

## Stop conditions

Stop when the current loop is not understood, authority ownership is missing, or failure cannot be detected and recovered.

## Refusals

- It does not add an agent, schedule, or human checkpoint when the workflow does not require one.
- It does not automate consent, payment, deletion, publication, or permission decisions without explicit authority gates.
- It does not hide nondeterminism, retries, cost, or partial failure behind a generic automation step.
