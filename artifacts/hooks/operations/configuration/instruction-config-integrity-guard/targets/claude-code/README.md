# instruction-config-integrity-guard

Install with `npx @youdede/toolkit add instruction-config-integrity-guard`. On project and local `ConfigChange`, the hook verifies a bounded regular JSON file inside the active project and blocks explicit hook or permission bypass settings. On `InstructionsLoaded`, it observes Project and Local instruction paths that cannot be verified inside the project.

Managed policy is never blocked. Instruction loading itself cannot be blocked by Claude Code, so that half is deliberately fail-open and emits only a content-free diagnostic.

## Refusals and limits

- It does not block or override managed enterprise policy settings.
- It does not rewrite settings, permissions, hooks, or instruction files.
- It does not interpret natural-language instructions or scan arbitrary project content.
- It does not claim accepted settings are secure beyond the listed explicit bypass rules.
