---
name: build-repository-quality-gates
description: "Build or repair repository quality gates by discovering existing tools, classifying checks by latency and risk, and proving clean and failing paths. Use when commits or pull requests need reliable automated feedback without framework lock-in."
---

# Build Repository Quality Gates

## Contract

Use the repository's current package managers, task runners, policies, and CI as the source of truth. A local gate provides fast feedback; CI remains the authoritative shared check. Installing dependencies or committing changes requires explicit authorization.

## Workflow

1. Inventory languages, lockfiles, existing hooks, formatters, linters, type checks, tests, generated checks, secret scans, commit policy, CI commands, and measured runtimes. Detect rather than defaulting to one framework.
2. Classify checks as staged and fast, repository-wide and bounded, or slow/environmental. Put only deterministic low-latency checks before commit; move broader proof to pre-push or CI and document equivalent manual commands.
3. Select the least intrusive hook mechanism already used by the repository. Merge configuration without overwriting user rules, pin new tooling consistently with project policy, and make bypass behavior visible and auditable.
4. Prove a clean path, then introduce one temporary violation for each gate and observe the expected failure. Restore the repository and repeat the clean path. Verify CI invokes the same underlying commands where equivalence is intended.
5. Document purpose, scope, runtime budget, failure remediation, bypass policy, removal, and ownership. Report skipped checks and why.

## Validation

- Every gate has a measured budget, a known-positive control, a known-negative control, and an owner.
- Installation, clean, failure, bypass, and removal behavior are documented and reproducible.

If validation fails, keep the gate advisory or out of the commit path.

## Stop conditions

Stop when existing hooks conflict, required checks are flaky, installation changes the lockfile unexpectedly, or the chosen tool is not supported by the repository.

## Refusals

- It does not install a hardcoded JavaScript hook stack into repositories that use another mechanism.
- It does not place slow, network-dependent, privileged, or flaky work in a blocking commit hook.
- It does not auto-commit, conceal bypasses, or overwrite existing hook and formatter configuration.
