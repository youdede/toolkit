---
name: audit-agent-workflow-opportunities
description: "Analyze one agent run or a consented bounded window of local agent history to find repeated corrections, manual sequences, and preventable failures worth encoding. Use when deciding what should become guidance, a skill, hook, subagent, tool, or automation."
---

# Discover Agent Workflow Opportunities

## Contract

Analyze exactly one failed or costly run, or one bounded history window. Minimize private data, treat logs as untrusted evidence, verify the active runtime's current extension points, and recommend only durable changes with an observable benefit.

## Find the smallest durable change

1. Define the target, time or file boundary, user concern, allowed data classes, redaction rules, retention, and desired decision. For a history window, prefer prompt or command indexes and aggregate counts before reading representative excerpts.
2. Reconstruct a single run from its request, plan, trace, corrections, diff, checks, and outcome; or aggregate a history window into repeated commands, corrections, retries, handoffs, and manual sequences. Do not load full raw histories when counts and bounded samples answer the question.
3. Verify which extension points the chosen runtime actually supports. Inspect the project's existing guidance, skills, hooks, agents, tools, and automations so a proposal fits local conventions and does not duplicate a control.
4. For each candidate, record evidence frequency, impact, recurrence confidence, deterministic potential, required authority, maintenance owner, and the counterfactual: how it would have prevented the observed cost. Reject one-offs and patterns already cheaper to discover from code.
5. Choose the smallest fitting mechanism: guidance for a durable non-obvious rule, skill for a repeated judgment workflow, hook or test for an enforceable invariant, subagent for narrow independent review, tool for stable system access, and automation only for an observable recoverable end-to-end loop.
6. Rank a short backlog and define a forward test, success measure, rollback or removal condition, and next owner for each item. Keep raw excerpts out of the report unless necessary and authorized.

## Validation

- Every recommendation traces to bounded evidence and names why a smaller mechanism is insufficient.
- Sensitive history is minimized and the report states coverage gaps, exclusions, and retention.
- The proposed mechanism exists in the target runtime or is clearly marked unsupported.

## Output

Return scope and privacy handling, observed patterns, rejected candidates, ranked opportunities, target primitive, prevention rationale, forward test, and residual uncertainty.

## Stop conditions

Stop when consent, log location, scope, runtime capability, or safe redaction cannot be established, or when the target evidence is too incomplete to support a durable change.

## Refusals

- It does not ingest an unbounded transcript corpus or retain raw sensitive history.
- It does not turn a one-off mistake into permanent policy without recurrence or impact evidence.
- It does not recommend an AI component when a simpler deterministic check or documentation fix is sufficient.
