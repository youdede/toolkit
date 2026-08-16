---
name: author-effective-agent-skill
description: "Create or improve a portable Agent Skill with a narrow trigger, lean procedure, explicit boundaries, progressive disclosure, deterministic helpers, and forward validation. Use for SKILL.md authoring and review."
---

# Author Effective Agent Skill

## Contract

One skill should add one capability or discipline. Its description routes activation; its body tells the agent exactly what evidence and boundaries govern execution.

## Workflow

1. Collect realistic trigger prompts, near misses, intended runtimes, authority boundaries, output contract, failure modes, and representative repository constraints before drafting.
2. Choose a verb-object lowercase slug. Write frontmatter with what the skill does, when it applies, and how it differs from adjacent skills; keep procedural detail out of the description.
3. Put the smallest useful workflow in SKILL.md. Move deterministic repeated logic into scripts and long optional detail into directly linked references. Avoid personal paths and time-sensitive claims.
4. Resolve this skill's installed directory and run `node scripts/validate-skill.mjs <skill-directory>` for deterministic structure and link checks. Then forward-test positive and negative prompts, validate metadata in each target runtime, inspect scripts for unsafe I/O or network behavior, and iterate until triggering and outputs are reliable.

## Validation

- Folder, slug, frontmatter, links, scripts, and target metadata pass their validators.
- Positive prompts activate the skill and near-miss prompts do not.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop when the proposed skill is only a style preference, duplicates an existing capability, or requires authority that belongs in a hook or external tool.

## Refusals

- It does not create a monolithic skill that bundles unrelated workflows.
- It does not hide required setup, network access, credential use, or destructive behavior.
- It does not claim portability without testing target-specific extensions separately.
