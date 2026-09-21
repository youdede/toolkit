---
description: Audit release evidence for the current version and emit a machine-readable verdict report. Use before proposing a release.
allowed-tools: Read, Grep, Glob, Bash
---

# Audit Release Evidence

Verify that the release evidence chain supports the candidate version — nothing more.

## Step 0 — Preconditions (mandatory, deterministic)

```bash
node "${CLAUDE_PLUGIN_ROOT}/commands/youdede/audit-release-evidence/check-preconditions.mjs"
```

- Exit 0: continue.
- Exit non-zero: stop. Release evidence on a dirty worktree does not attribute to the candidate; report and stop.

## Step 1 — Re-run the evidence checks

1. Run the repository's declared release-readiness checks (validation, evaluations, contracts, catalog and integrity verification) exactly as documented.
2. Record command, exit code, and output hash per check. `--scope <checks>` restricts the audit to the named checks; state the restriction in the report.
3. A check you cannot run is **unknown**, never **passed**.

## Step 2 — Verify identity and history

1. Confirm the package version matches the changelog section and any tag being proposed.
2. Confirm the worktree HEAD is the commit the evidence ran against; record its sha.

## Step 3 — Emit the report

Machine-readable JSON: version, commit sha, per-check verdicts with output hashes, unknowns, and an overall `ready` boolean that is `true` only when every check is verified and no unknowns exist. Print the JSON path and a five-line human summary.

## Refusals

- Do not publish, tag, bump versions, or bypass any release guard.
- Do not treat skipped checks as passed.
- Do not start when preconditions fail.
