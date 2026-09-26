# Playwright local isolated MCP threat contract

The official `@playwright/mcp` package is pinned to `0.0.82`. The browser is isolated and service workers are blocked. Browser requests are limited by `--allowed-origins http://127.0.0.1:*`, which upstream documents as not a security boundary and not applied to redirects; callers must stop if navigation leaves loopback. `--allowed-hosts 127.0.0.1` restricts the hosts the server's HTTP transport serves from, not browser navigation. When `mcp-egress-guard` from the `secure-agent-boundaries` pack is installed, it blocks tool calls whose arguments name a host other than the declared egress (`127.0.0.1` and `registry.npmjs.org`; `localhost` is refused), and `file:` URLs outside the workspace. It inspects arguments only: it does not see redirects or requests the page starts on its own.

No secrets, existing browser profile, or authenticated remote session is supplied. The upstream `browser_file_upload` tool stays exposed and can upload files under the workspace root, the upstream default file-access boundary; callers must not call it. `pinnedTools` remains empty until the exact observed inventory is reviewed, so the contract claims exact package/launch pinning and bounded browsing flags, not description-level tool pinning.

## Refusals

- No remote or credentialed browsing.
- No calls to `browser_file_upload` and no persistent browser profile.
- No claim that origin flags alone contain every redirect.
