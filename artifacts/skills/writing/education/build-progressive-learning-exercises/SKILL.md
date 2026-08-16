---
name: build-progressive-learning-exercises
description: "Build a progression of learning exercises from objectives and prerequisite skills, with learner prompts, reference solutions, feedback, accessibility, and structural validation. Use when authoring workshops, courses, or practice repositories."
---

# Build Progressive Learning Exercises

## Contract

Start from demonstrated learner outcomes, not folder names. Each exercise must have one assessable objective, declared prerequisites, a learner-facing prompt, feedback path, and an accessible non-visual explanation where visuals are used.

## Workflow

1. Define audience, prior knowledge, mission, time budget, environment, accessibility needs, and observable terminal outcomes. Separate teaching material from assessment evidence.
2. Build a prerequisite graph from the outcomes. Sequence retrieval, worked example, guided practice, independent practice, and transfer only where each stage earns its place.
3. Draft a JSON plan with stable section and exercise ids, objective, prerequisites, variants, expected evidence, feedback mode, estimated effort, and source references. Use problem and solution variants only when they support the objective.
4. Run `node scripts/validate-exercise-plan.mjs <plan.json>` from this installed skill. Resolve missing references, cycles, backward prerequisites, duplicate ids, and empty objectives before creating files.
5. Scaffold using the repository's conventions, then run its real lint, link, build, and exercise commands. Have a novice or clean environment follow at least one path without author knowledge.

## Validation

- The deterministic plan check passes and every objective maps to observable learner evidence.
- Links, starter state, solution state, commands, and accessibility alternatives work from a clean setup.

If validation fails, repair the plan or content before expanding the course.

## Stop conditions

Stop when outcomes, learner prerequisites, repository conventions, or an executable validation path are missing.

## Refusals

- It does not create empty directories or title-only placeholders and call them complete exercises.
- It does not reveal solutions in starter material or make formatting cues disclose quiz answers.
- It does not auto-commit, renumber unrelated content, or rely on one proprietary course linter.
