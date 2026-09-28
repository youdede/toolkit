# instruction-config-integrity-guard

Install with `npx @youdede/toolkit add instruction-config-integrity-guard`. On project and local `ConfigChange`, the hook verifies a bounded regular JSON file inside the active project and blocks explicit hook or permission bypass settings. The project root is `CLAUDE_PROJECT_DIR`, or else the nearest directory at or above the event `cwd` (below the home directory) that holds `.claude`; an omitted `file_path` is the source's canonical `.claude/settings.json` or `.claude/settings.local.json`, and deleting either file is allowed, since it introduces no bypass value. On `InstructionsLoaded`, it observes Project and Local instruction paths that cannot be verified inside the project.

Managed policy is never blocked. Instruction loading itself cannot be blocked by Claude Code, so that half is deliberately fail-open and emits only a content-free diagnostic.

## Refusals and limits

- It does not block or override managed enterprise policy settings.
- It does not rewrite settings, permissions, hooks, or instruction files.
- It does not interpret natural-language instructions or scan arbitrary project content.
- It does not claim accepted settings are secure beyond the listed explicit bypass rules.
