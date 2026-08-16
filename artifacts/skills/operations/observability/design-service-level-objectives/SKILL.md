---
name: design-service-level-objectives
description: "Design or audit service-level indicators, objectives, error budgets, windows, alerts, and operating policy around critical user journeys. Use when a team needs a reliability target that can guide engineering and incident decisions."
---

# Design Service Level Objectives

## Contract

An objective represents acceptable user-visible unreliability for a defined population and window. It is not a target chosen from industry convention or whatever metric is already easy to collect.

## Define the reliability contract

1. Identify critical journeys, users, service boundaries, dependencies, business impact, existing commitments, failure modes, maintenance, traffic variation, and decision owners.
2. Choose event or time-based indicators with valid numerator, denominator, eligibility, exclusions, source, latency, and handling of missing telemetry. Validate against observed user experience.
3. Set objectives and windows from needs and baseline, then define error-budget calculation, multi-window burn alerts, ownership, escalation, release policy, and exception process.
4. Backtest against incidents and healthy periods, simulate telemetry gaps, compare alert behavior, document limitations, and schedule objective review as product and architecture change.

## Validation

- Indicator math, population, source, exclusions, and missing-data behavior are explicit.
- Objectives connect to user and business evidence plus a measured baseline.
- Alerts and error-budget policy are backtested and tied to actionable ownership.

## Stop conditions

Stop when the user journey, indicator data, contractual commitments, telemetry reliability, or owner of budget decisions is unclear.

## Refusals

- It does not copy an arbitrary availability percentage or hide exclusions to meet it.
- It does not equate component health with end-user success without evidence.
- It does not create paging alerts or release blocks without owner approval.
