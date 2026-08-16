---
name: map-multi-session-decisions
description: "Map an effort too uncertain for one session into a destination, resolved decisions, bounded decision nodes, dependency frontier, unknown territory, and handoff rules. Use before execution when premature task breakdown would encode guesses."
---

# Map Multi Session Decisions

## Contract

The map exists to remove uncertainty before execution. Its nodes resolve questions, not implementation slices. Keep one canonical index and link detailed evidence instead of copying it into every session.

## Workflow

1. Define the destination as an observable planning outcome and set scope boundaries. If the remaining decisions fit one bounded session, use a simpler decision workflow instead.
2. Record what is already decided, what is known but unresolved, and what is visible only as uncertain territory. Promote uncertainty into a node only when its question can be stated precisely.
3. Create bounded decision nodes with id, question, owner, evidence needed, output contract, dependencies, interaction mode, and stop condition. Dependencies must represent information prerequisites, not preferred order.
4. Compute the frontier: unresolved nodes whose dependencies are resolved and which are not already claimed. A session claims one node, resolves it with evidence, records the decision once, and updates affected nodes and uncertainty.
5. Re-evaluate destination and scope after every resolution. Close superseded nodes explicitly, keep execution outside the map unless authorized, and hand off when the next frontier is clear.

## Validation

- Every resolved decision has one authoritative record and each open node has a precise answerable question.
- Frontier selection can be recomputed from status, claim, and dependency data without relying on session memory.

If validation fails, repair the map before launching more sessions.

## Stop conditions

Stop when the destination has shifted without owner approval, no frontier exists because of a cycle, or a node requires unavailable human judgment.

## Refusals

- It does not pre-slice unknown territory into invented tasks merely to make the map look complete.
- It does not let concurrent sessions claim the same decision or duplicate its authoritative answer.
- It does not treat a planning map as authority to execute external, destructive, or privileged actions.
