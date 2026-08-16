---
name: plan-dependency-upgrade
description: "Plan or review an application dependency upgrade using installed versions, release and migration documentation, affected usage, transitive changes, compatibility tests, rollout, and rollback. Use when an upgrade is material, breaking, security-driven, or framework-wide."
---

# Plan Dependency Upgrade

## Contract

Upgrade the smallest coherent dependency set supported by current evidence. Inspect the installed ecosystem and official versioned guidance; do not infer migration steps from remembered APIs.

## Map and prove the upgrade

1. Resolve current and target versions, package manager, lockfile, runtime, peer and transitive constraints, support windows, security reason, release notes, and official migration guides.
2. Inventory imports, configuration, generated code, plugins, build and deployment paths, data formats, public APIs, and behavior likely affected. Identify coupled upgrades and incompatible consumers.
3. Design staged changes with a compatibility shim or reversible checkpoint where useful. Add characterization, contract, build, integration, migration, and rollback tests before changing versions.
4. Apply one dependency group at a time, regenerate through approved tools, inspect lockfile and transitive deltas, run required checks, test representative runtime paths, and document deployment monitoring.

## Validation

- Target versions and migration steps cite official versioned sources.
- The impact inventory connects breaking changes to actual repository usage.
- Lockfile, build, tests, runtime, security findings, rollout, and rollback are verified.

## Stop conditions

Stop when target support, peer compatibility, official guidance, data migration, rollback, or production rollout authority is unresolved.

## Refusals

- It does not upgrade unrelated packages to achieve a clean latest state.
- It does not edit lockfiles manually or suppress peer and security warnings without evidence.
- It does not claim compatibility from compilation or unit tests alone when runtime boundaries changed.
