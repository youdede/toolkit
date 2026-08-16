---
name: audit-agent-guidance-drift
description: "Audit AGENTS.md, CLAUDE.md, and equivalent scoped guidance for stale paths, false commands, contradictory precedence, or newly durable invariants. Use before integration or after structural repository changes when agent instructions may have drifted."
---

# Audit Agent Guidance Drift

## Contract

Treat guidance as a small steering surface, not project documentation. Verify claims against the selected diff and current repository, respect runtime precedence, and propose the minimum correction without writing unless authorized.

## Audit the changed boundary

1. Resolve the comparison range, current status, runtime, and every applicable root or scoped guidance file. Record current official filename, global/project/nested precedence, launch-directory behavior, imports, limits, and reload semantics before judging overlap.
2. Inspect renamed or removed paths, changed commands, ownership boundaries, generated surfaces, architecture seams, and security or release invariants in the diff. Use static read-only evidence first. Treat repository-owned checks as code execution: classify write, network, install, credential, and publication effects, then sandbox them or obtain explicit approval before running them.
3. Classify each candidate as now false, contradictory under precedence, newly durable, unchanged, obvious from code, revision-scoped history, or uncertain. “Newly durable” requires a stable cross-task invariant or repeated costly ambiguity, not one implementation choice; an old path that remains valid only on historical revisions is not a current instruction. Only the first three can justify an edit.
4. Draft one minimal replacement or addition per evidenced issue. Prefer a canonical file or command reference over copied implementation detail, and remove a stale line rather than layering a contradiction.
5. Check the proposed guidance from files inside and outside each scope, verify authorized commands at their documented working directory, and return the smallest unified diff before any write.

## Validation

- Every proposed change cites the guidance claim, repository evidence, applicable scope, and why code discovery is insufficient.
- Parent and child guidance remain compatible, authorized commands execute where stated without undisclosed effects, and unchanged guidance is not reformatted.

## Output

Return the checked range and scopes, required fixes, justified additions, unchanged claims verified, unresolved uncertainty, and the smallest proposed diff.

## Stop conditions

Stop when the comparison range, target runtime, precedence, repository state, or policy owner is ambiguous enough to make an edit unsafe.

## Refusals

- It does not turn guidance into a changelog or inventory of obvious code facts.
- It does not add a rule from one incidental implementation choice.
- It does not edit guidance or weaken policy without explicit approval.
