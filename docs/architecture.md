# Architecture

The repository separates the meaning of an artifact from the way a specific agent runtime installs it.

## Canonical layer

`artifact.json` is the source of truth for discovery. It contains identity, version, kind, granular taxonomy, compatibility, and explicit refusals. Nothing target-specific belongs in an id or directory name.

Each manifest also declares a controlled capability, operational behavior and failure policy, plus typed relationships. `composesWith`, `conflictsWith`, `supersedes`, and `prerequisites` reference stable artifact ids; `packIds` connects the artifact to installable outcome packs.

The adjacent `risk_reason` and `operational.latency_reason` explain those two classifications for each artifact. `risk` concerns what using the artifact can do, not the severity of a problem under review; `latencyClass` concerns the steps and operations required, not an unmeasured time estimate. The [catalog audit](audits/risk-latency-2026-09-23.md) records the evidence and unresolved external-runtime cases behind the current values.

It also declares whether execution is `prompt`, `hybrid`, or `deterministic`. Hybrid and deterministic artifacts list executable entrypoints, their runtimes, purposes, and side-effect classes. See [deterministic components](deterministic-components.md).

The stable path is:

```text
artifacts/<kind-plural>/<domain>/<category>/<slug>/
```

An id mirrors that path with a singular kind, for example `hook/security/secrets/commit-guard`.

## Adapter layer

`adapters/<target>.json` maps payload files into a runtime. Adapters declare supported scopes, stability, known limitations, and optional settings patches. Artifact-local payloads remain canonical; audited package runtime bridges may be mapped explicitly when several targets need the same bounded transport logic.

The Claude Code adapter maps:

| Kind | Project destination | User destination |
| --- | --- | --- |
| Skill | `.claude/skills/<slug>/` | `~/.claude/skills/<slug>/` |
| Hook | `.claude/hooks/youdede/<slug>.mjs` (a few hooks add shared files under `.claude/hooks/youdede/`) plus settings merge | deliberately unsupported |
| Subagent | `.claude/agents/<slug>.md` | `~/.claude/agents/<slug>.md` |

Codex uses component-specific native roots:

| Kind | Project destination | User destination |
| --- | --- | --- |
| Skill | `.agents/skills/<slug>/` | `~/.agents/skills/<slug>/` |
| Hook | `.codex/hooks/youdede/<slug>.mjs` plus `.codex/hooks.json` merge | deliberately unsupported |
| Subagent | deliberately unsupported | deliberately unsupported |

Codex skill adapters also package `agents/openai.yaml` and every declared helper. Twenty-two shell-only gates have native Codex hook adapters; custom agents are withheld.

Gemini CLI, GitHub Copilot, Cursor, and OpenCode use their native component roots and generated target profiles where frontmatter differs. The complete coverage, the per-runtime gate mechanics, and the reasons for every withheld combination are in [targets.md](targets.md). Adding a runtime requires a taxonomy entry, a component-aware root definition, target-aware validation, fixtures, and adapter files; it never means copying a Claude payload into a differently named folder and declaring success.

## Composition packs

`packs/<slug>/pack.json` composes independently installable artifacts into one outcome. Members declare their role as procedure, collector, specialist, verifier, enforcement, observer, entrypoint, baseline, or integration. Validation rejects missing members, repeated ids, invalid kind-role mappings, packs with no common target, and more than three hook processes on the same event/matcher boundary. The generated pack catalog exposes this fan-out explicitly.

`add-pack` plans every required member and rejects cross-member path collisions before writing, then records an ownership reference for the pack. Directly installed artifacts retain a separate owner, so removing a pack does not delete an artifact the user also installed individually. Install and removal snapshot every affected payload, settings, MCP configuration, generated notice, and state file; a failed operation restores the exact pre-operation bytes and modes. Removal follows recorded ownership rather than only the current pack manifest, so members and whole packs remain uninstallable after catalog evolution.

## Safety boundaries

- Manifest and adapter paths are resolved and checked against their expected roots.
- The installer does not execute artifact payloads.
- Existing unmanaged files are not overwritten without `--force`.
- Settings changes are additive and identified by a stable toolkit marker at the target's documented identity field.
- Uninstall removes only recorded files and exact hook entries.
- Hook scripts cap stdin and file sizes, parse structured input, avoid `eval`, and default to narrow matchers.
- Every declared deterministic entrypoint must exist inside the artifact and be packaged by every supported adapter.
- Repository validation rejects duplicate identities, unsafe paths, missing payloads, unbundled entrypoints, and invalid runtime contracts.

## Catalog

`catalog/artifacts.json` and `catalog/packs.json` are generated from canonical manifests in lexicographic id order. Hand edits are rejected by CI. Website and API consumers should treat these files as disposable indexes and link back to canonical manifests for full detail.

`catalog/integrity.json` is a deterministic public attestation index. Each artifact digest covers its manifest, payloads, adapters, evaluations, and package-root runtime bridges mapped by its adapters. The root digest covers the ordered artifact attestations. Installation rejects drift before copying. The manifest is unsigned and must be authenticated through the release channel; it is not proof of authorship or ownership.
