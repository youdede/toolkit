# Release readiness

Build an evidence-backed release decision and stop publication from unsafe repository state.

## What it contains

- **Audit Release Evidence** (command): Audit the release evidence chain for the current version and emit a machine-readable verdict report.
- **Verify Production Release** (skill): Release an exact revision through CI and prove deployment health before completion.
- **Release Risk Reviewer** (subagent): Review a bounded release candidate for evidence-backed rollout, rollback, and verification risk.
- **Release Evidence Verifier** (subagent): Verify whether a bounded release claim is supported by fresh, correctly identified, criterion-linked evidence.
- **Release clean state guard** (hook): Require a clean attached Git worktree before a recognized package or release publication command.
- **Release version consistency guard** (hook): Require package and lockfile versions to agree before a recognized publication command.
- **Shell command guard** (hook): Block high-confidence destructive shell commands before Claude Code executes them.
- **Package publish guard** (hook): Block real ecosystem package publication while allowing local packaging and dry runs.

## What it runs

Hooks run local Node.js scripts from `hooks/youdede/` on the tool calls and session events they declare. They make no network requests. Some run local `git` commands to read repository state.

Every member states what it refuses to do. Read each file before you install it.

Source and evidence: https://github.com/youdede/toolkit/blob/main/packs/release-readiness/pack.json

License: MIT. See `LICENSE` and `NOTICE`.
