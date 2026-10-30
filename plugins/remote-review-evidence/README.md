# Remote review evidence

Collect bounded GitHub evidence in read-only mode and turn failing CI evidence into a traceable diagnosis.

## What it contains

- **Diagnose CI Failure** (command): Diagnose a failing CI run from supplied logs and repository evidence without mutating workflows or rerunning jobs.
- **Debug CI Failure** (skill): Trace a failing CI job to the earliest actionable divergence and a minimal discriminating check.
- **CI Failure Analyst** (subagent): Analyze one bounded CI failure for evidenced cause, discriminating checks, and safe next steps.
- **GitHub Read-only MCP** (mcp-server): Inspect bounded GitHub repository, issue, pull-request, and Actions evidence through the official server in read-only mode.

## What it runs

MCP server `youdede-github-readonly` runs locally over stdio. Its profile under `.youdede/mcp/` lists the only hosts it may reach (`egress`) and the secrets it may read (`secretAccess`).

Every member states what it refuses to do. Read each file before you install it.

Source and evidence: https://github.com/youdede/toolkit/blob/main/packs/remote-review-evidence/pack.json

License: MIT. See `LICENSE` and `NOTICE`.
