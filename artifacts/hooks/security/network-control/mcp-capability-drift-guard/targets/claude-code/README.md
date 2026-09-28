# MCP capability drift guard

This fail-closed pre-tool hook recognizes only `youdede-*` MCP identities, in any letter case: `mcp__<server>__<tool>`, the plugin-scoped `mcp__plugin_<plugin>_<server>__<tool>` that Claude Code uses for plugin servers, `mcp_server.name`, and Cursor's `mcp_server_name`. It compares the server and tool name with `mcp-pins.json`, and also compares a description or full observed inventory whenever the native client includes that evidence. Claude Code's documented `PreToolUse` payload does not include a description, so there only the names are checked.

Servers with an empty pin set (`youdede-github-readonly`, `youdede-playwright-local-isolated`) are blocked until their tools are pinned with `re-pin-mcp-tools`.

## Refusals

- It refuses unknown curated server and tool identities.
- It refuses description hashes or observed inventories that differ from the generated registry.
- It refuses malformed, empty, oversized, or uninspectable hook envelopes without echoing their content.
