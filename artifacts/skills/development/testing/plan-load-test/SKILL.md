---
name: plan-load-test
description: Plan a bounded load, stress, soak, or spike test from a representative workload model, service objectives, production safeguards, observability, and explicit abort criteria. Use before testing capacity or claiming performance at scale.
---

# Plan a Load Test

## Contract

Require the decision, target environment, user journey, traffic mix, arrival pattern, data volume, service objectives, downstream dependencies, capacity limits, observability, and accountable operator. Planning does not authorize load generation against any environment.

## Model and contain the experiment

1. Derive request classes, concurrency or arrival rate, session behavior, payload distribution, cache state, think time, geographic factors, background work, and expected growth from measured evidence. Label synthetic assumptions.
2. Choose load, stress, spike, or soak behavior based on the decision. Define warm-up, steady phases, ramps, duration, repetitions, control run, and one variable changed at a time where practical.
3. Establish the safety envelope: approved target, tenant isolation, synthetic accounts, data cleanup, rate ceiling, cost budget, downstream coordination, abort owner, and automatic thresholds for errors, latency, saturation, data integrity, and spend.
4. Define observations across client latency, throughput, errors, queues, utilization, throttling, dependency health, tail behavior, and recovery after load. Preserve timestamped configuration and result artifacts.

## Validation

Produce `## Workload model`, `## Safety envelope`, `## Measurement plan`, and `## Exit criteria`. State baseline, success thresholds, abort thresholds, confounders, and how repeated results will be compared. A percentile without sample count, window, and workload is incomplete evidence.

## Stop conditions

Stop when target ownership, environment authorization, workload evidence, abort controls, monitoring, or downstream approval is missing. Recommend a smaller component benchmark when full-system isolation is unavailable.

## Refusals

- Do not run load against production, third-party systems, or shared environments without explicit scoped authorization.
- Do not create unbounded traffic, uncontrolled cost, destructive test data, or a denial-of-service condition.
- Do not claim capacity from averages, a single run, a nonrepresentative workload, or client-side metrics alone.
