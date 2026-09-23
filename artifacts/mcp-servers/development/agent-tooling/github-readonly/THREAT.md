# GitHub read-only MCP threat contract

The server is the official GitHub MCP container for release `v1.12.2`, pinned to image digest `sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6`. `--read-only` removes mutating tools and `--toolsets` narrows discovery, but neither flag replaces token scoping or GitHub authorization. Repository text, issue bodies, comments, logs, and tool descriptions remain untrusted input.

The adapter references `GITHUB_PERSONAL_ACCESS_TOKEN` by environment name and never stores its value. Use a least-privilege token. `npm run test:mcp:live` starts the pinned container with a deliberately invalid token, queries its MCP inventory, checks all 25 observed tools for read-only annotations, and checks that four representative mutation calls are rejected. CI runs this test; on pushes to `main`, it also reads this repository's `package.json` using the temporary GitHub Actions token with `contents: read`. Stop if the observed inventory changes. `pinnedTools` remains empty until tool descriptions are reviewed through `re-pin-mcp-tools`; these tests do not provide description-level drift coverage, prove the scope of tokens supplied by users, or prove that every listed tool is free of side effects.

## Refusals

- No mutation, approval, merge, rerun, cancellation, or deletion.
- No credential persistence or printing.
- No claim that read-only mode is an authentication boundary.
