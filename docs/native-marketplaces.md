# Native marketplaces

The repository publishes generated native marketplace surfaces for Claude Code and Codex. They are
packaging views of the catalog, not separately authored content: `npm run marketplaces` rebuilds
them and `npm run check:marketplaces` refuses drift.

## Claude Code

Add the repository marketplace, then install a complete pack plugin:

```bash
claude plugin marketplace add udede/toolkit
claude plugin install release-readiness@youdede-toolkit
```

`.claude-plugin/marketplace.json` contains twelve pack plugins, one for every pack except `plan-and-verify-loop`. Their descriptions are the pack
summaries, their versions are the pack versions, and their metadata records the exact member IDs,
declared refusal count, and evidence badges. Generated hooks and MCP server paths resolve through
`${CLAUDE_PLUGIN_ROOT}`, so cached installs stay self-contained.

`plan-and-verify-loop` is intentionally absent from this marketplace. It requires the
`coding-style-baseline` and `testing-baseline` context artifacts, while the Claude plugin contract
does not load project context files. The npm installer remains the complete installation path for that pack. Publishing a partial
plugin under the same name would overstate the composition.

## Codex

Add the repository marketplace, then install the generated skill plugin:

```bash
codex plugin marketplace add udede/toolkit
codex plugin add youdede-toolkit@youdede-toolkit
```

`.agents/plugins/marketplace.json` points to `plugins/youdede-toolkit`, whose
`.codex-plugin/plugin.json` exposes all 166 Codex-compatible skills. Commands, contexts, hooks, MCP
servers, and subagents are withheld because this compatibility manifest does not preserve their
runtime contracts. `resume-session-work` is also withheld: its hash-chained ledger runtime and
lifecycle hooks are Claude-only, so its previous prompt-only Codex adapter could not satisfy the
skill's own precondition. The root `.codex-plugin/plugin.json` exposes the same generated skills when
the repository itself is loaded as a plugin.

The machine-readable compatibility and omission record is
[`catalog/native-marketplaces.json`](../catalog/native-marketplaces.json). The source formats follow
the [Claude Code marketplace contract](https://code.claude.com/docs/en/plugin-marketplaces) and the
[OpenAI plugin marketplace format](https://learn.chatgpt.com/docs/enterprise/plugin-management).
