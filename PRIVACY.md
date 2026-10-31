# Privacy

The youdede toolkit collects no data. It has no server, account, analytics, or telemetry. Youdede receives nothing from your use of it.

Everything it installs runs on your computer, inside the coding agent you install it into. What that agent's provider receives is governed by the provider's own terms.

## What the artifacts read

Hooks read the tool call or session event that triggered them, such as a shell command, a file path, or a file write, and decide whether to block it. Some run local `git` commands to read repository state. They keep nothing after they exit and make no network requests.

Skills, commands, and subagents are instructions to the agent. They read only what the agent reads while following them.

## What is stored on your computer

The `session-continuity` pack keeps a local session ledger at `.youdede/session-ledger.jsonl` in your project. It holds redacted work checkpoints that you or a session hook write, is bounded to 1 MiB, and stays there until you delete it. It is never sent anywhere.

The `npx @youdede/toolkit` installer records what it installed in `.youdede-toolkit/state.json` under the agent's configuration folder, so that `remove` can undo it.

## What leaves your computer

Only these MCP servers make network requests, and only when the agent calls them:

- `youdede-allowlisted-fetch-readonly` (`mcp-baseline` pack) fetches pages from developer.mozilla.org, docs.github.com, and nodejs.org.
- `youdede-github-readonly` (`remote-review-evidence` pack) calls the GitHub API with the token you supply. In the Claude Code plugin, Claude Code asks for the token and keeps it in the system keychain.
- `youdede-playwright-local-isolated` (`browser-verification` pack) is downloaded from registry.npmjs.org at first start and opens only pages on 127.0.0.1.

Each server's profile under `.youdede/mcp/` lists the hosts it may reach (`egress`) and the secrets it may read (`secretAccess`).

## Contact

Questions about this policy: open an issue as described in [SUPPORT.md](SUPPORT.md), or write to info@youdede.eu.
