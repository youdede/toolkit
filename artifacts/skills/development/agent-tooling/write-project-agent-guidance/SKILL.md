---
name: write-project-agent-guidance
description: "Create or repair root-level AGENTS.md, CLAUDE.md, or equivalent project guidance from verified repository evidence and current runtime precedence. Use when onboarding an agent runtime or replacing generic generated instructions with durable project-specific rules."
---

# Write Project Agent Guidance

## Contract

Create the smallest root steering document that removes costly ambiguity. Preserve existing guidance, resolve target-runtime precedence from current documentation, and link to canonical project records instead of copying them.

## Build the root guidance

1. Inspect repository status, existing guidance and imports, package boundaries, validation entrypoints, generated files, ownership, issue workflow, architecture records, secrets-policy documents, and release controls without opening secret values. Classify repository-owned commands by write, network, install, credential, and publication effects before running them; obtain approval for effects beyond read-only inspection.
2. Record a runtime-precedence evidence block for every intended runtime: canonical filename and location, global/project/nested order, launch-directory or edited-file discovery, import support, byte or truncation limits, and reload behavior. If no guidance exists, present verified filename options rather than choosing silently; if one exists, update it idempotently instead of creating a competing file.
3. Select only durable non-obvious content: repository purpose, authoritative commands with working directories, validation requirements, forbidden or approval-gated mutations, generated boundaries, canonical context links, and genuinely stable architecture seams.
4. Propose excluding generic coding advice, feature status, exhaustive directory tours, copied code, secrets, personal paths, speculative ownership, and facts cheaply discoverable from code. Preserve existing user-authored material until its removal is explicitly approved; move accepted detail to one canonical document or scoped guide.
5. Show the proposed structure and exact diff. After approval, edit narrowly while preserving line endings, modes, imports, and overlapping user changes. Verify paths and scope in a disposable clean worktree or report why that is unavailable; run only commands whose classified effects are authorized.
6. Record how to update and remove the guidance. Propose, rather than schedule, a drift review when repository change cadence justifies one unless scheduling authority is explicit.

## Validation

- Every instruction is durable, project-specific, non-obvious, and backed by a current path, command, policy, or owner decision.
- Runtime precedence and inheritance are evidenced for every target and work without duplicate or contradictory guidance.
- Re-running the procedure against unchanged evidence is byte-stable and produces no duplicate sections or unrelated formatting churn.

## Output

Return discovered evidence, unresolved owner choices, proposed root structure, excluded material and destination, exact diff, validation results, and maintenance trigger.

## Stop conditions

Stop when target runtimes, precedence, canonical commands, command effects, policy authority, or overlapping user edits cannot be resolved safely.

## Refusals

- It does not invent commands, architecture, tracker conventions, or ownership from filenames alone.
- It does not duplicate canonical documentation or encode transient work status as permanent guidance.
- It does not overwrite existing agent guidance or choose a new runtime filename without review.
