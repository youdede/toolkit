---
name: verify-production-release
description: "Prepare and verify a production release using an exact revision, required checks, deployment evidence, health probes, and rollback awareness. Use when production release authority is explicit."
---

# Verify Production Release

## Contract

Release the reviewed revision through the repository’s normal protected path. A pushed commit, green build, and healthy deployment are separate claims and each needs evidence.

## Workflow

1. Confirm explicit production authorization, target environment, branch or tag policy, release window, owner, rollback mechanism, and the exact commit intended for release.
2. Inspect working tree, review the complete diff since the last release, run required local checks, and confirm secrets and generated artifacts are handled by established policy.
3. Push without force or bypass flags through the normal remote. Observe required CI and deployment jobs for the exact SHA; do not substitute an adjacent run.
4. Verify application health, critical user journey, migrations, queues, errors, and version endpoint. Report evidence and remaining risk; initiate the documented rollback path if release criteria fail.

## Validation

- Required checks and deployment identify the exact approved SHA.
- Post-deploy health and one critical path meet the repository release criteria.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop before push or deploy when authorization, branch protection, migration safety, or rollback readiness is unclear.

## Refusals

- It does not force-push, bypass checks, or weaken branch protection.
- It does not deploy a dirty, unreviewed, or ambiguous revision.
- It does not declare production healthy from CI success alone.
