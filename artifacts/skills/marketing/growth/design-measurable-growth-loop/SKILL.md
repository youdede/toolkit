---
name: design-measurable-growth-loop
description: "Design or audit a product, content, referral, collaboration, or data growth loop using explicit actors, state transitions, incentives, delays, leakage, and measurement. Use when a team believes an action can create the next qualified input and needs to test whether it truly compounds."
---

# Design Measurable Growth Loop

## Contract

A loop must close through observable behavior; a repeated campaign is not automatically a loop. Model user value, system constraints, and decay before forecasting compounding growth.

## Model and test the loop

1. Name the actor, value received, trigger action, artifact or signal produced, exposed audience, next actor, and the event that closes the loop. Draw each state and delay.
2. Quantify conversion, cycle time, branching, saturation, quality, fraud, cost, and leakage at every edge. Identify the limiting edge rather than multiplying optimistic averages.
3. Design the smallest loop test with valid instrumentation, cohort boundaries, abuse controls, user consent, and a benchmark against non-loop acquisition or retention.
4. Review whether each cycle creates durable user value and an incremental qualified input. Repair the limiting edge, change the mechanism, or stop if the loop depends on coercion or subsidy.

## Validation

- The loop diagram identifies actors, events, delays, leakage, and the exact closing transition.
- A cohort calculation uses observed edge rates and includes quality, cost, and saturation.
- The test can distinguish genuine recirculation from repeated paid or manual pushes.

## Stop conditions

Stop when the loop cannot close observably, value is one-sided, growth relies on unsolicited contact, or required identity and sharing violate user expectations.

## Refusals

- It does not label a funnel, campaign cadence, or referral request a compounding loop without a closing event.
- It does not manufacture sharing, contacts, content, reviews, or invitations.
- It does not forecast exponential growth from unvalidated conversion assumptions.
