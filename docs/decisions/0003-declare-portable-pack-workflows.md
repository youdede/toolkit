# 0003: Declare portable pack workflows

- Status: Proposed
- Date: 2026-11-15

## Context

A member list cannot express where a user starts, which reviewer runs next, or when a specialist
is relevant. Requiring a subagent for assurance also excludes runtimes that can install skills
but cannot represent subagents. Audit workflows need ordered phases and explicit activation
signals while retaining bounded review responsibilities and honest evidence claims.

## Decision

Extend the existing pack manifest with optional fields rather than creating a pack or an artifact.
The term audit describes a workflow category in this decision; it does not add a `kind` enum or
change the artifact taxonomy. Audit entry instructions should inventory the supplied scope,
select reviews using observed signals, consolidate findings, request verification, and report
coverage and unresolved disagreement. Phases describe that sequence without granting execution
or modification authority beyond the invoked member's contract.

### Decisions

- `entry` is a logical member artifact ID, restricted to a required `procedure` or `entrypoint`.
  An entrypoint may be a skill or command; a skill entrypoint satisfies the procedure requirement.
- `workflow` is a non-empty ordered array of `{member, phase, signal?}` objects. `member` names a
  declared logical member; `phase` is a slug. Array position is the only ordering mechanism.
  Repeated members and phases are allowed; passive members need not appear in the sequence.
- `signal` is optional plain text of 1-240 characters, interpreted by the runtime agent against
  observed evidence. Its absence means unconditional activation. It is neither executable code
  nor a new evidence status. Audit instructions should record the reason for activating a review
  and make unavailable inputs visible rather than inventing coverage.
- Member `targets` is a non-empty map from known target names to artifact IDs. Member `fallback`
  is one artifact ID. Selection precedence is explicit target, fallback, original `artifactId`.
  An explicit selection never retries another member after an installation error. All alternatives
  must exist and match the declared role; resolved member IDs must be distinct.
- Entry, workflow, and outcome mappings use the original logical member ID. Plans expose selected
  artifact IDs and resolve entry and workflow references for the chosen target. Installation uses
  the same selection function and preserves member declaration order, independent of use order.
- A required skill verifier satisfies assurance, including on runtimes without subagents. Distinct
  procedure and verifier skills satisfy composition without a second artifact kind. The existing
  catalog criterion named `crossKindRequiredWorkflow` includes this exception for compatibility.
  A verifier role assigns responsibility; it does not attest to independent runtime execution.
- All new fields are optional and absent fields remain absent in the public catalog. Existing
  packs keep their manifests, installation behavior, and generated catalog content unchanged.
- Evidence mappings and report validation retain their current contracts. No specialist reference
  generator, evidence-state extension, or new evaluation format is introduced by this decision.

## Consequences

- Skill entry and verifier members make portable audit workflows expressible without pretending
  every runtime has subagents. Authors remain responsible for the selected skill's instructions.
- Target compatibility, planning, and installation use selected members. An unsupported required
  selection still prevents installation before mutation; optional member errors retain their
  existing refusal behavior.
- Declared phase order and activation signals are inspectable metadata. The installer does not
  execute phases, evaluate signals, schedule reviewers, or certify audit coverage.
- Logical outcome IDs remain stable, but runtime receipts for replacement artifacts need a future
  evidence design before they can be interpreted automatically as equivalent reports.
- This decision supersedes no earlier record. See [pack format](../pack-format.md) for the contract.
