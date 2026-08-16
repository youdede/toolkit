---
name: decompose-dependent-work-slices
description: "Decompose a plan or specification into bounded vertical work items, explicit acceptance evidence, and verified blocking edges. Use when work must be delegated or sequenced without losing end-to-end value."
---

# Decompose Dependent Work Slices

## Contract

Each work item must deliver an observable outcome through every required layer, fit one bounded execution context, and declare only genuine blockers. Publishing items to an external tracker requires separate authorization.

## Workflow

1. Read the complete approved plan, acceptance criteria, architecture decisions, current repository, and delivery constraints. Separate unresolved decisions from executable work.
2. Draft the thinnest end-to-end slice that proves the riskiest path. Continue with independently demoable slices; place preparatory work only where no outcome can remain green without it.
3. For broad mechanical migrations, use expand, bounded migration batches, and contract removal rather than pretending each layer is an end-to-end feature.
4. Give every item a stable id, outcome, non-goals, inputs, acceptance evidence, rollback or recovery note, and explicit blockers. Put implementation hints below the contract and label them non-binding.
5. Save the draft graph as JSON and run `node scripts/validate-work-graph.mjs <graph.json>` from this installed skill. Review its topological order and ready frontier before seeking approval or publishing.

## Validation

- The graph has unique ids, no missing blockers, no self-dependencies, and no cycles.
- Each non-preparatory item can be verified and reviewed without requiring an unlisted item.

If validation fails, revise the graph before creating any ticket.

## Stop conditions

Stop when the source plan is unapproved, acceptance behavior is missing, or a dependency represents uncertainty that needs a decision rather than a ticket.

## Refusals

- It does not split work into database, backend, frontend, and test layers that are unusable alone.
- It does not publish, label, assign, close, or modify tracker items without authorization.
- It does not disguise a cyclic plan by omitting or weakening real blocking edges.
