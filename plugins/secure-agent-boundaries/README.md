# Secure agent boundaries

Design agent integrations, review their trust boundary, and block obvious data-exposure paths.

## What it contains

- **Review Agent Tool Boundaries** (skill): Review agent and MCP tool authority against prompt injection, confused-deputy, exfiltration, and unsafe side effects.
- **Author MCP Server Contract** (skill): Design an MCP server with narrow tools, safe schemas, authority boundaries, and protocol evidence.
- **Application Security Reviewer** (subagent): Fallback cross-boundary application-security review when no narrower security specialist fits.
- **MCP Trust Boundary Reviewer** (subagent): Review a bounded MCP server surface for authority, injection, validation, credential, and data-flow risks.
- **Outbound data guard** (hook): Block explicit local-file uploads and dynamic payloads sent by common network commands.
- **Sensitive file access guard** (hook): Block deterministic access to credential files, private keys, and environment secret files.
- **MCP capability drift guard** (hook): Block toolkit MCP calls whose server or tool name is not pinned, or whose supplied description differs from the pin.
- **MCP egress guard** (hook): Block toolkit MCP tool calls whose arguments name a host outside the server's declared egress.
- **Shell command guard** (hook): Block high-confidence destructive shell commands before Claude Code executes them.

## What it runs

Hooks run local Node.js scripts from `hooks/youdede/` on the tool calls and session events they declare. They make no network requests. Some run local `git` commands to read repository state.

Every member states what it refuses to do. Read each file before you install it.

Source and evidence: https://github.com/youdede/toolkit/blob/main/packs/secure-agent-boundaries/pack.json

License: MIT. See `LICENSE` and `NOTICE`.
