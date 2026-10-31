# Data change safety

Review schema and migration changes with deterministic safety checks and independent risk analysis.

## What it contains

- **Review Database Migration Plan** (skill): Review a database migration plan for explicit SQL hazards and an evidenced rollout, rollback, lock, and backfill plan.
- **Review Schema Evolution** (skill): Review schema evolution across real readers, writers, stored records, rollout order, compatibility policy, and recovery.
- **Migration Risk Reviewer** (subagent): Review a bounded schema or data migration for compatibility, integrity, lock, and recovery risk.
- **Migration safety guard** (hook): Require explicit approval for high-confidence destructive database migration actions.
- **Shell command guard** (hook): Block high-confidence destructive shell commands before Claude Code executes them.

## What it runs

Hooks run local Node.js scripts from `hooks/youdede/` on the tool calls and session events they declare. They make no network requests. Some run local `git` commands to read repository state.

Every member states what it refuses to do. Read each file before you install it.

Source and evidence: https://github.com/youdede/toolkit/blob/main/packs/data-change-safety/pack.json

License: MIT. See `LICENSE` and `NOTICE`.
