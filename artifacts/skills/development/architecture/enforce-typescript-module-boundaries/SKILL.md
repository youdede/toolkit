---
name: enforce-typescript-module-boundaries
description: "Inspect and enforce TypeScript module boundaries so consumers import through declared entry points while internals remain local. Use when deep imports, package cycles, or test access make contracts and refactors unreliable."
---

# Enforce TypeScript Module Boundaries

## Contract

Discover the repository's real package roots, entry-point declarations, aliases, test policy, generated paths, and existing graph tools before choosing enforcement. Public surface is a project contract, not automatically every root file or one barrel.

## Workflow

1. Inspect workspace manifests, exports maps, TypeScript paths, bundler config, existing dependency rules, package layout, imports, tests, and CI. Define package identity and public entry points from evidence.
2. Run `node scripts/inspect-module-boundaries.mjs --root <package-root>` from this installed skill for a read-only baseline of relative cross-package deep imports. Use `--tests-as-consumers` only if tests must obey public boundaries.
3. Classify findings as true violation, approved friend boundary, generated code, migration bridge, unresolved alias, or scanner limitation. Choose an existing graph tool where possible; otherwise add the smallest supported rule set.
4. Migrate consumers to stable entry points. Avoid catch-all barrels that enlarge initialization graphs or conceal environment-specific exports; prefer explicit exports that match runtime and type resolution.
5. Prove clean pass, temporary forbidden import failure, restored pass, cycle detection, build resolution, type checking, and representative runtime loading. Add the command to the repository's shared validation path.

## Validation

- Enforcement matches package exports and resolves the same paths as the compiler and runtime.
- Positive and negative controls prove deep-import and cycle rules fail for the intended reason.

If validation fails, keep the scanner advisory and correct resolution assumptions.

## Stop conditions

Stop when package identity, entry points, aliases, or runtime resolution differ across environments without an owner decision.

## Refusals

- It does not install or overwrite a dependency-analysis tool before inspecting existing configuration.
- It does not treat unresolved aliases or generated imports as proven violations.
- It does not create a giant barrel, break environment-specific exports, or claim architecture quality from path depth alone.
