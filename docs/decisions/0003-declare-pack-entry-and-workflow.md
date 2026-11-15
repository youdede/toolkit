# 0003: Declare a pack entry and workflow

- Status: Accepted
- Date: 2026-11-15

## Context

A member list cannot express where a user starts, which member comes next, or when a specialist
is relevant. A person who installs a pack has to read every member to find out.

## Decision

Add two optional fields to the existing pack manifest rather than a new artifact kind or file.

- `entry` is the artifact ID of a required member with role `procedure` or `entrypoint`.
- `workflow` is a non-empty ordered array of `{member, phase, signal?}` objects. `member` names a
  declared member and `phase` is a slug. Array position is the only ordering mechanism. Members
  can repeat, and passive members need not appear.
- `signal` is plain text of 1-240 characters that the agent reads against what it observes. Its
  absence means the step always applies. It is neither executable code nor an evidence status.
- Absent fields stay absent in the public catalog. Existing rules for roles, composition,
  prerequisites, and evidence are unchanged.

## Not decided here

Selecting a different member per target, with a fallback, was considered and left out: no shipped
pack needs it, and it would also require relaxing the rule that a pack carries a subagent
specialist or verifier. It can be proposed again with a pack that needs it.

## Consequences

- The entry and order are inspectable metadata shown by `pack-info`, `add-pack`, and the catalog.
- The installer does not execute phases, evaluate signals, or certify coverage.
- This decision supersedes no earlier record. See [pack format](../pack-format.md).
