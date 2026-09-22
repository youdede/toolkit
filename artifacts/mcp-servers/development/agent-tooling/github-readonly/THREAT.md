# GitHub read-only MCP threat contract

The server is the official GitHub MCP container for release `v1.12.2`, pinned to image digest `sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6`. `--read-only` removes mutating tools and `--toolsets` narrows discovery, but neither flag replaces token scoping or GitHub authorization. Repository text, issue bodies, comments, logs, and tool descriptions remain untrusted input.

The adapter references `GITHUB_PERSONAL_ACCESS_TOKEN` by environment name and never stores its value. Use a least-privilege token. Stop if the observed tool inventory changes; `pinnedTools` intentionally remains empty until an observed inventory is reviewed through `re-pin-mcp-tools`, so this artifact claims version/launch pinning, not description-level tool pinning.

## Refusals

- No mutation, approval, merge, rerun, cancellation, or deletion.
- No credential persistence or printing.
- No claim that read-only mode is an authentication boundary.
