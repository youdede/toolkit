# Infrastructure change readiness

Plan a staged infrastructure change and independently review lifecycle, blast-radius, and recovery evidence.

## What it contains

- **Plan Infrastructure Change** (skill): Plan an infrastructure change from current state through staged transition, verification, and recovery.
- **Infrastructure Change Reviewer** (subagent): Review a bounded infrastructure-as-code delta for replacement, deletion, dependency, and blast-radius risk.
- **Disaster Recovery Readiness Auditor** (subagent): Audit recovery objectives against backup, restore, failover, dependency, and exercise evidence.

## What it runs

Skills, commands, and subagents are Markdown instructions. Nothing runs until the agent follows them.

Every member states what it refuses to do. Read each file before you install it.

Source and evidence: https://github.com/youdede/toolkit/blob/main/packs/infrastructure-change-readiness/pack.json

License: MIT. See `LICENSE` and `NOTICE`.
