# Browser verification

Exercise an unauthenticated local interface in an isolated browser, preserve journey-level evidence, and review the change for web performance risks.

## What it contains

- **Test Interface In Browser** (skill): Exercise a bounded browser journey with state, network, console, accessibility, and visual evidence.
- **Web Performance Reviewer** (subagent): Review a bounded web change for evidenced loading, rendering, responsiveness, and regression risks.
- **Playwright Local Isolated MCP** (mcp-server): Verify local browser interfaces through an exact Playwright MCP release with isolated state and loopback-only origins.

## What it runs

MCP server `youdede-playwright-local-isolated` runs over stdio with `npx --yes @playwright/mcp@0.0.82 --isolated --block-service-workers --allowed-hosts 127.0.0.1 --allowed-origins http://127.0.0.1:*`. Its profile under `.youdede/mcp/` lists the only hosts it may reach (`egress`) and the secrets it may read (`secretAccess`).

Every member states what it refuses to do. Read each file before you install it.

Source and evidence: https://github.com/youdede/toolkit/blob/main/packs/browser-verification/pack.json

License: MIT. See `LICENSE` and `NOTICE`.
