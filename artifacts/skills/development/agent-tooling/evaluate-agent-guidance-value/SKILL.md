---
name: evaluate-agent-guidance-value
description: "Design and run a controlled ablation of repository agent guidance using isolated matched trials, rule-level scoring, and explicit uncertainty. Use when deciding whether AGENTS.md, CLAUDE.md, or equivalent always-loaded instructions should be kept, shortened, moved, or removed."
---

# Measure Agent Guidance Value

## Contract

Measure a bounded claim about always-loaded guidance; do not treat one model run as proof that a rule is useless. Keep the user's checkout unchanged, hold every observable runtime input constant, and separate prompt guidance from hooks, permissions, skills, and other enforcement.

## Design the experiment

1. Inventory project, nested, global, organization-managed, fallback, imported, and size-truncated instruction surfaces for the chosen runtime. Classify each item as always loaded, on demand, or enforcement; report cost in bytes and, only when the tokenizer is known, tokens. Turn only observable rules into numbered claims.
2. Choose a representative task where selected claims can affect an objective oracle. Freeze the complete task envelope: text bytes, attachments, repository revision, working directory, environment, locale, permissions, tools, plugins, session state, model identifier, and runner settings. Define trial count, decision threshold, broken-arm rule, cost and external-effect ceiling, and isolation for ports, caches, credentials, daemons, and remote systems.
3. Before launching any trial, obtain approval for the design, maximum cost, and side effects. Create matched arms in disposable workspaces, change only selected guidance, use a length-matched placebo when position or prompt length could confound the result, and record the random seed, arm assignment, and run order. Capture only redacted evidence needed for grading rather than complete traces by default.
4. Grade each blinded trial against each rule as followed, violated, not applicable, partially followed, or uninspectable. Compare control health and within-arm variance before between-arm difference; mark weak probes, unequal failure rates, silent runtime drift, and broken trials instead of forcing a verdict.
5. Classify rules as load-bearing, redundant under the tested conditions, ignored even when present, untested, or noisy. Do not declare rare safety guidance redundant from average task success alone; use authorized threat cases or retain uncertainty. Propose the smallest next action: keep, shorten, move on demand, propose a deterministic control, redesign the probe, or remove.
6. Show the proposed diff and limitations. Apply no guidance or enforcement change without separate approval, then repeat a representative probe after any accepted change.

## Validation

- Every verdict names applicable trials, observable evidence, within-arm variance, and untested conditions.
- Control and ablated arms differ only in the declared guidance surface or documented placebo, use isolated recoverable workspaces, and have a recorded environment fingerprint.
- Trial evidence is privacy-minimized, control-arm failures are surfaced, and any deterministic promotion remains proposal-only.
- A null result is scoped to the chosen task, runtime, model, and revision.

## Output

Return an experiment design, a blinded rule-by-trial evidence table, revealed verdicts, validity threats, cost, and proposed changes requiring approval.

## Stop conditions

Stop when the task has no objective oracle, trials cannot be isolated, runner failures make an arm unusable, confidential data would enter logs, or the cost or external effects exceed approval.

## Refusals

- It does not delete or rewrite guidance from a single clean run.
- It does not disable hooks, permissions, or other enforcement while testing prompt guidance.
- It does not run costly, destructive, external, or production-facing probe tasks without explicit approval.
