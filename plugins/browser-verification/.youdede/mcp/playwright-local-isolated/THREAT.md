# Playwright local isolated MCP threat contract

The official `@playwright/mcp` package is pinned to `0.0.82`. The browser is isolated, service workers are blocked, and both host and origin flags are restricted to `127.0.0.1`. The allowed-origin flag is not a complete security boundary and does not make redirects safe; callers must stop if navigation leaves loopback.

No secrets, existing browser profile, authenticated remote session, or upload path is supplied. `pinnedTools` remains empty until the exact observed inventory is reviewed, so the contract claims exact package/launch pinning and bounded browsing flags, not description-level tool pinning.

## Refusals

- No remote or credentialed browsing.
- No uploads or persistent browser profile.
- No claim that origin flags alone contain every redirect.
