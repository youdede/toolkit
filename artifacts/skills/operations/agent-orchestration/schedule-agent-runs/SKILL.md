---
name: schedule-agent-runs
description: "Plan recurring or delayed agent work using the runtime scheduler, cron, or a supervised loop. Use when a task must run later or repeatedly and needs explicit state, permissions, output, and recovery behavior."
---

# Schedule Agent Runs

## Contract

Choose the smallest scheduling mechanism that can satisfy the timing and reliability requirement. Keep the scheduled job narrower than the current request and make every run observable.

## Workflow

1. Define the event: record timezone, cadence or exact timestamp, missed-run policy, maximum runtime, and the condition that ends the schedule.
2. Choose the mechanism from evidence: prefer a runtime-native scheduler; use cron for minute-level local work; use a supervised loop only for short-lived interactive monitoring. Verify availability with the tool or command help.
3. Separate durable state from output. Record the last successful checkpoint atomically, make repeated runs idempotent, and send results to a stable file, issue, or approved notification channel.
4. Install only after the user has authorized the recurring side effect. Trigger a bounded dry run or one-shot execution, then verify registration, first execution, output, and failure reporting.

## Validation

- The registered schedule matches the requested timezone and cadence.
- A one-shot run proves state, permissions, output, timeout, and failure behavior.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop when scheduling requires credentials, external messaging, billing, or permissions the user did not place in scope.

## Refusals

- It does not invent authority for future writes or external messages.
- It does not create an unbounded polling loop or conceal failed runs.
- It does not claim a schedule works until registration and one execution are verified.
