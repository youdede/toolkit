# MCP capability drift guard

This fail-closed pre-tool hook recognizes only `youdede-*` MCP identities. It compares the server and tool name with `mcp-pins.json`, and also compares a description or full observed inventory whenever the native client includes that evidence.

## Refusals

- It refuses unknown curated server and tool identities.
- It refuses description hashes or observed inventories that differ from the generated registry.
- It refuses malformed, oversized, or uninspectable hook envelopes without echoing their content.
