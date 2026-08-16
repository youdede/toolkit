---
name: write-folder-agent-guidance
description: "Create or update folder-scoped agent instruction files after inspecting runtime precedence and repository boundaries. Use when a subtree needs commands or constraints that differ from the repository root."
---

# Write Folder Agent Guidance

## Contract

Write only durable, folder-specific facts that cannot be discovered cheaply. Preserve inherited instructions and use the exact filename and precedence supported by each target runtime.

## Workflow

1. Read every applicable parent guidance file and current official runtime rules. Map which files apply to the target folder and where multiple runtimes require equivalent but distinct files.
2. Inspect the subtree for commands, ownership, generated files, boundaries, and non-obvious hazards. Remove advice that is generic, duplicated from root, speculative, or likely to rot.
3. Draft concise scoped instructions: purpose, authoritative commands, required validation, forbidden mutations, and references to canonical docs. State runtime-specific differences explicitly.
4. Test from files inside and outside the subtree, check precedence and contradictions, and run the documented commands. Review the final diff with repository owners when policy changes.

## Validation

- The guidance applies only to the intended subtree and does not contradict parents.
- All commands and paths in the guidance exist and work at the documented location.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop when runtime precedence is uncertain or when proposed rules would silently override security, ownership, or release policy.

## Refusals

- It does not duplicate the root guidance into every folder.
- It does not invent commands, paths, owners, or runtime precedence.
- It does not weaken inherited safety or quality policy without explicit review.
