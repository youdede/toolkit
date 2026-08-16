---
name: optimize-with-performance-profile
description: "Diagnose and optimize application performance using a representative workload, profile evidence, resource constraints, user impact, and before-and-after verification. Use when latency, throughput, memory, CPU, network, rendering, or cost has a measurable problem."
---

# Optimize With Performance Profile

## Contract

Performance work starts with a stable symptom and budget. Optimize the evidenced bottleneck at the correct layer without trading away correctness, security, accessibility, or maintainability silently.

## Measure, isolate, improve

1. Define affected user or system outcome, workload, environment, revision, baseline distribution, performance budget, correctness guardrails, and measurement noise.
2. Profile the full path and attribute time or resources to components. Reproduce under controlled conditions, inspect saturation and variance, and identify the earliest limiting mechanism.
3. Form one optimization hypothesis, select the smallest change, predict its effect and tradeoffs, and add a benchmark or trace capable of falsifying it.
4. Apply the change, rerun identical measurements enough times for stability, compare distributions and resource use, run correctness checks, and document residual bottlenecks.

## Validation

- Baseline and result use the same workload, environment, tools, and statistical summary.
- A profile identifies the optimized mechanism rather than relying on intuition.
- Regression protection and correctness, cost, and tail-latency guardrails pass.

## Stop conditions

Stop when the workload is unrepresentative, measurements are unstable, production profiling lacks approval, or the proposed optimization changes required behavior.

## Refusals

- It does not optimize from anecdotes, averages alone, or synthetic microbenchmarks disconnected from the issue.
- It does not hide correctness, readability, cost, energy, or accessibility regressions.
- It does not claim a performance win from different environments or measurement methods.
