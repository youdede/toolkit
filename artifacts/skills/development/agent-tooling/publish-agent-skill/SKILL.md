---
name: publish-agent-skill
description: "Prepare and publish an agent skill to a Git repository with clean packaging, compatible licensing, provenance, validation, and deliberate release metadata. Use after the skill is tested and publication is authorized."
---

# Publish Agent Skill

## Contract

Publishing is a release, not a file copy. Verify ownership, license, secrets, version, target compatibility, and exact diff before any external write.

## Workflow

1. Confirm the destination repository, publication authority, branch policy, versioning scheme, package layout, required notices, and whether the skill is standalone or part of a catalog.
2. Audit frontmatter, scripts, references, assets, external calls, credentials, personal paths, licenses, and provenance. Forward-test triggers and failure cases in supported runtimes.
3. Prepare a scoped branch and reviewable diff. Update manifest, catalog, changelog or release notes only when those files are canonical for the destination.
4. Run all repository checks, commit intentionally if requested, push without force, and open or update the normal review surface. Verify the published revision and installation command before announcing it.

## Validation

- The exact published revision passes repository and skill validators.
- A clean installation from the published source discovers and runs the skill.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop before external writes when repository ownership, licensing, secrets, or publication authorization is unresolved.

## Refusals

- It does not create a repository, commit, push, or release without authorization.
- It does not publish private paths, credentials, client data, or incompatible licensed content.
- It does not force-push or bypass required review and checks.
