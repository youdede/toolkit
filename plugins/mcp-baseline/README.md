# MCP baseline

Install a guarded read-only MCP baseline with declared authority and independent trust-boundary review.

## What it contains

- **MCP capability drift guard** (hook): Block toolkit MCP calls whose server or tool name is not pinned, or whose supplied description differs from the pin.
- **Allowlisted fetch read-only MCP** (mcp-server): Fetch bounded HTTPS documentation from three explicit hosts through a pinned MCP server.
- **Repository Git read-only MCP** (mcp-server): Expose bounded local Git status, diff, and history inspection through a pinned MCP server.
- **Workspace files read-only MCP** (mcp-server): Expose bounded read-only workspace file inspection through a locally pinned MCP server.
- **Author MCP Server Contract** (skill): Design an MCP server with narrow tools, safe schemas, authority boundaries, and protocol evidence.
- **Review Agent Tool Boundaries** (skill): Review agent and MCP tool authority against prompt injection, confused-deputy, exfiltration, and unsafe side effects.
- **MCP Trust Boundary Reviewer** (subagent): Review a bounded MCP server surface for authority, injection, validation, credential, and data-flow risks.

## What it runs

Hooks run local Node.js scripts from `hooks/youdede/` on the tool calls and session events they declare. They make no network requests. Some run local `git` commands to read repository state.

MCP server `youdede-allowlisted-fetch-readonly` runs locally over stdio. Its profile under `.youdede/mcp/` lists the only hosts it may reach (`egress`) and the secrets it may read (`secretAccess`).

MCP server `youdede-repository-git-readonly` runs locally over stdio. Its profile under `.youdede/mcp/` lists the only hosts it may reach (`egress`) and the secrets it may read (`secretAccess`).

MCP server `youdede-workspace-files-readonly` runs locally over stdio. Its profile under `.youdede/mcp/` lists the only hosts it may reach (`egress`) and the secrets it may read (`secretAccess`).

Every member states what it refuses to do. Read each file before you install it.

Source and evidence: https://github.com/youdede/toolkit/blob/main/packs/mcp-baseline/pack.json

License: MIT. See `LICENSE` and `NOTICE`.
