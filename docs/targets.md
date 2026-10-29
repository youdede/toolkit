# Runtime targets

Support is declared per artifact. A missing adapter is an intentional refusal, not an installation bug.

## Coverage

<!-- stat-table:targets -->
| Target | Skills | Hooks | Subagents | Commands | Contexts | MCP servers | Project root | User root |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Claude Code | 167 | 64 | 62 | 10 | 8 | 5 | `.claude` | `~/.claude` |
| Codex | 166 | 22 | 0 | 0 | 0 | 0 | skills: `.agents`; hooks/agents: `.codex` | skills: `~/.agents`; hooks/agents: `~/.codex` |
| Gemini CLI | 166 | 22 | 62 | 0 | 0 | 0 | `.gemini` | `~/.gemini` |
| GitHub Copilot | 166 | 0 | 62 | 0 | 8 | 0 | `.github` | `$COPILOT_HOME` or `~/.copilot` |
| Cursor | 166 | 24 | 0 | 0 | 8 | 5 | `.cursor` | `~/.cursor` |
| OpenCode | 166 | 22 | 50 | 0 | 0 | 0 | `.opencode` | `~/.config/opencode` |
<!-- /stat-table -->

Context adapters are intentionally project-scoped. Claude Code receives `.claude/rules/youdede/*.md`,
Cursor receives `.cursor/rules/*.mdc`, and GitHub Copilot receives
`.github/instructions/*.instructions.md`. Codex, Gemini CLI, and OpenCode adapters are withheld
because their aggregate instruction files do not provide an independently removable, path-scoped
surface for each toolkit context. Numeric filename prefixes preserve the toolkit's declared
precedence order; where a runtime does not define cross-file precedence, install-set validation
rejects known context/hook contradictions instead of claiming the runtime resolves them.

Gemini CLI availability changed on 2026-06-18: Google stopped serving it for free use and for Google AI Pro and Ultra, and moved those users to Antigravity CLI. Gemini CLI remains available through Gemini Code Assist Standard or Enterprise licenses and paid API keys. Every Gemini CLI adapter states this limitation. Antigravity CLI is not a target; whether it loads `.gemini` skills, agents, or hooks is not verified.

Every published skill adapter uses the runtime's native `skills/<slug>/SKILL.md` location and carries its scripts or references through the same installation. Only Codex receives `agents/openai.yaml`. `resume-session-work` is published only for Claude Code: its hash-chained ledger library and lifecycle hooks install only there, so on Codex, Gemini CLI, GitHub Copilot, Cursor, and OpenCode its prompt alone would fail the skill's own deterministic precondition.

## Specialist profiles

Gemini profiles convert the Claude tool allowlist to `read_file`, `grep_search`, and `glob`, and preserve `maxTurns` as `max_turns`. Gemini CLI enables subagents by default; users can disable them with `experimental.enableAgents`. GitHub Copilot profiles use `.agent.md`, map the read-only tools to `read` and `search`, and carry the turn budget as an explicit instruction because the profile format does not enforce it. GitHub documents custom agents as public preview in JetBrains IDEs, Eclipse, and Xcode, so these profiles stay preview; Copilot skill adapters are stable because GitHub documents Agent Skills for its cloud agent, code review, CLI, app, and agent mode in Visual Studio Code and JetBrains IDEs without a preview label.

OpenCode receives 50 profiles with a deny-all permission baseline plus explicit `read`, `grep`, and `glob` grants. Twelve profiles that request a model reasoning-effort setting are withheld because OpenCode cannot preserve that setting while inheriting an arbitrary model. Cursor profiles are withheld because `readonly` cannot reproduce the existing per-tool allowlist and would silently expose the parent's broader read, network, browser, or MCP surface.

Codex custom agents are deliberately withheld. The native TOML format supports a read-only sandbox, but an agent that omits `mcp_servers` inherits the parent MCP configuration and the format does not provide the closed `Read`/`Grep`/`Glob` allowlist required by this catalog's specialist contract. Publishing a profile would therefore broaden authority compared with the canonical artifact. The installer already resolves Codex agent roots through `.codex`, so support can be added without a layout migration if the native boundary becomes equivalent.

## Deterministic gates

The first cross-runtime gate tranche contains <!-- stat:hook-count:codex -->22<!-- /stat --> shell-only `PreToolUse` guards. Codex registers them in `.codex/hooks.json` as synchronous `PreToolUse` command hooks matched to `Bash`; an exit code of 2 blocks the call, and each handler has a bounded timeout. Gemini registers them as `BeforeTool` with millisecond timeouts and an input bridge. Cursor registers native `preToolUse` handlers with `Shell`, `failClosed: true`, and second-based timeouts. OpenCode installs one local `.js` plugin per selected guard, filters `tool.execute.before` to shell calls, normalizes the working directory, and invokes the bounded policy core with Node.js.

Write/edit, prompt, transcript, compaction, configuration, worktree, failure-context, and task-completion hooks remain Claude-only until target-native fixtures prove that their preventive boundary and failure policy survive translation. The MCP capability-drift guard also has a Cursor preview adapter: unknown toolkit MCP identities always fail closed, while description drift is checked when Cursor supplies the description or observed inventory. The MCP egress guard has a Cursor preview adapter bound to `beforeMCPExecution` with `failClosed: true` and no matcher, because Cursor's hooks page (read 2026-09-26) documents that event's `mcp_server_name` and string `tool_input` fields but no matcher value for it; Cursor does not run that event in cloud agents. GitHub Copilot hooks are withheld because documented hook timeouts always fail open, which conflicts with the fail-closed promise of the enforcement catalog.

Installing an OpenCode guard executes local plugin code when OpenCode starts and requires a reload after changes. Codex exact command hooks require the workspace to be trusted; Gemini and Cursor project hooks are likewise subject to their runtime trust controls. Node.js 20 or later must remain available for JavaScript helpers and cross-runtime deterministic gates.

## Commands, contexts, and MCP servers

Three further kinds extend the catalog beyond procedures, gates, and specialists:

- **Commands** are user-invoked workflows whose manifests declare a tool allowlist, a mandatory deterministic precondition check as their first action, and the evidence the workflow must produce. The native command surface does not provide a pre-prompt dispatcher, so the installed prompt instructs the runtime to run that check before any other workflow step; invocation-time enforcement remains a runtime/model boundary. A runtime adapter is published only where the native command surface preserves the invocation name, tool authority, and evidence requirement.
- **Contexts** are scoped rule files. Because a context shapes every decision while installed, an adapter is published only where the runtime applies the file with its declared scope and precedence, and the install validator refuses a context that contradicts a co-installed gate.
- **MCP servers** are vetted tool-server configurations with declared egress, secret access, and a pinned tool manifest. Claude Code project installs merge exact entries into `.mcp.json`; Cursor project installs use `.cursor/mcp.json`. Both receive the same generated local runtime and profiles beneath `.youdede/mcp/`. Existing unrelated configuration is preserved, uninstall restores any explicitly displaced entry, and `doctor` reports missing or modified managed entries. User-scope adapters and remote transports are withheld. Per ADR 0002, no MCP server adapter is `stable` until an MCP egress guard covers its target: `mcp-egress-guard` covers Claude Code through `PreToolUse`, and covers Cursor only through a preview `beforeMCPExecution` adapter not yet verified in a live Cursor client, so every Cursor MCP server adapter is `preview`.

The coverage table above reports each kind per runtime; a zero is an intentional refusal until target-native fixtures prove equivalence, per the same contract that governs hooks and subagents.

## Operating systems

Linux runs the full check in CI on Node 20, 22, and 24; macOS runs it locally on the same three versions. Windows has no CI and has not been run, so everything below about Windows is read from runtime documentation (checked 2026-09-26) and is not verified.

How each runtime starts an installed hook on Windows, and what happens when the hook itself fails to start:

| Target | How the hook is started | A hook that fails to start |
| --- | --- | --- |
| Claude Code | Its shell runs the command: Git Bash by default, PowerShell when Git Bash is absent ([hooks](https://code.claude.com/docs/en/hooks)). Project hooks are addressed through `${CLAUDE_PROJECT_DIR}`, which PowerShell reads as its own variable rather than the environment one; whether Claude Code substitutes it first is not documented. | Only exit code 2 blocks; any other failure lets the action proceed. |
| Codex | The documentation does not name the shell; a `commandWindows` override exists and the toolkit does not set it ([hooks](https://learn.chatgpt.com/docs/hooks)). | The run is marked failed and the action proceeds. |
| Gemini CLI | Not documented ([hooks](https://geminicli.com/docs/hooks/)). Project hooks use `${GEMINI_PROJECT_DIR}`. | Codes other than 2 warn and the action proceeds. |
| Cursor | Not documented ([hooks](https://cursor.com/docs/agent/hooks)). | The toolkit sets `failClosed: true`, so a failure blocks. |
| OpenCode | The toolkit's plugin starts `node` directly, without a shell. | The plugin blocks on any non-zero result, including a failed start. |

So on Windows a Claude Code, Codex, or Gemini CLI hook that cannot be found or started does not block anything, and nothing reports it. Until a Windows run proves otherwise, check that a guard blocks one known command after installing it there.

Tests skipped on Windows, and the protection they would prove:

- Symbolic links, which Windows creates only with developer mode or elevation: the installer refuses destinations through a link and `doctor` reports an ancestor link without reading through it (`tests/install.test.mjs`); the session ledger never writes or reads through a linked ledger or state directory (`tests/session-ledger.test.mjs`); `file-exists` preconditions and the phase gate never follow a link out of the workspace (`tests/command-precondition.test.mjs`, `tests/phase-gate-guard.test.mjs`); validation against an alternate repository root and the release-readiness structural proof (`tests/behavioral-evaluations.test.mjs`, `tests/release-readiness.test.mjs`).
- POSIX file modes: installation state is owner-only, a settings merge keeps a restrictive existing mode, and a failed multi-file install rolls back (the test forces the failure with `chmod`) (`tests/install.test.mjs`).

## Official format references

- [Codex skills](https://developers.openai.com/codex/skills), [hooks](https://developers.openai.com/codex/hooks), and [custom agents](https://developers.openai.com/codex/subagents)
- [Gemini CLI skills](https://geminicli.com/docs/cli/skills/), [subagents](https://geminicli.com/docs/core/subagents/), and [hooks](https://geminicli.com/docs/hooks/reference/)
- [GitHub Copilot skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills) and [custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [Cursor skills](https://cursor.com/docs/skills), [subagents](https://cursor.com/docs/subagents), and [hooks](https://cursor.com/docs/hooks)
- [OpenCode skills](https://opencode.ai/docs/skills), [agents](https://opencode.ai/docs/agents), [permissions](https://opencode.ai/docs/permissions), and [plugins](https://opencode.ai/docs/plugins)
