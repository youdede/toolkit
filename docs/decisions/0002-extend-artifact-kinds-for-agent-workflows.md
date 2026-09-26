# 0002: Extend artifact kinds for agent workflows

- Status: Proposed
- Date: 2026-09-21

## Context

The catalog taxonomy admits three kinds: `skill`, `hook`, and `subagent`. Three surfaces are not
yet expressible: user-invoked workflow commands, always-on context/rules files, and vetted MCP
server configurations. Each has a distinct trust boundary:

- A **command** holds user-delegated authority to run tools in a defined order; its risk is scope
  creep beyond what the user invoked.
- A **context** file shapes every model decision while installed; its risk is silent behavioral
  drift and conflict with deterministic hooks.
- An **mcp-server** config grants a third-party process tool access; its risk is network egress and
  secret exposure outside any hook boundary.

Adding these kinds alters a long-lived interface (the taxonomy, the artifact schema, the catalog,
and the installer), so the choice requires a durable record.

## Decision

Extend `catalog/taxonomy.json` and `schema/artifact.schema.json` with three new kinds: `command`,
`context`, and `mcp-server`. Each kind gets:

1. A schema extension carrying kind-specific required fields:
   - `command`: `invocation` (slash name), `toolAuthority` (allowlist of tools the command may
     use), `produces` (evidence artifacts the command must emit), `requires` (preconditions checked
     deterministically as the command's mandatory first action), constraint-narrowing-only `flags`, and the shared
     `refuses` list.
   - `context`: `scope` (`always` | `glob`), `precedence`, optional `expires` (stale contexts warn
     on install), rule-level `provenance` links to catalog artifact IDs, and rule-level named
     `action` contracts that are checked against the `hookGuard.blockedActions` of hooks.
   - `mcp-server`: `transport`, `egress` (declared network destinations or `none`),
     `secretAccess` (allowlist or `none`), `trustBoundary` statement, and a `pinnedTools` manifest
     (names + description hashes) enabling capability-drift detection.
2. Adapter mappings for all six targets; where a runtime cannot express a kind (for example a
   runtime without slash commands), the adapter is withheld per authoring contract §4 rather than
   approximated.
3. Kind-specific validation in `scripts/lib/catalog.mjs` (run by `scripts/validate.mjs`) and fixture
   tests under `tests/`.
4. Doc and catalog generation updated so counts and `docs/catalog/` pages are regenerated, never
   hand-edited.

MCP server configs are distributed as manifests plus install-time materialization; the toolkit
never bundles or executes third-party server code. Session continuity is implemented with the
`hook`, `skill`, and `command` kinds (deterministic checkpoint scripts with declared retention and redaction),
not with a new kind.

## Consequences

- The installer, schema, taxonomy, catalog, integrity digest, and doc generators all change in the
  same release line; this is a minor version bump, not a patch.
- Withholding adapters where a runtime lacks the concept keeps the one-command install promise
  honest but means kind coverage differs per target; `docs/targets.md` must state the matrix.
- Every `mcp-server` artifact expands the audited trust surface; the `secure-agent-boundaries`
  pack must include an MCP egress guard before any `mcp-server` artifact is marked stable.
- Context files can contradict hooks; the validator must reject an install set where a context
  instructs behavior a co-installed hook blocks.
- Future kinds (for example `output-style` or `statusline`) can follow this same pattern: schema
  extension, kind-specific trust fields, withheld adapters, kind tests.
