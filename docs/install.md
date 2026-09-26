# Installation

## Commands

```bash
youdede-toolkit list [--kind skill|hook|subagent|command|context|mcp-server] [--target value] [--domain|--category|--capability|--problem|--framework|--language|--lifecycle|--risk|--execution value]
youdede-toolkit info <id-or-slug>
youdede-toolkit packs
youdede-toolkit pack-info <id-or-slug>
youdede-toolkit add <id-or-slug> --target claude-code|codex|gemini-cli|github-copilot|cursor|opencode --scope project|user [--cwd path] [--dry-run] [--json] [--force]
youdede-toolkit add-pack <id-or-slug> --target <target> --scope project|user [--cwd path] [--dry-run] [--json] [--force]
youdede-toolkit remove <id-or-slug> --target <target> --scope project|user [--cwd path]
youdede-toolkit remove-pack <id-or-slug> --target <target> --scope project|user [--cwd path]
youdede-toolkit doctor --target <target> --scope project|user [--cwd path]
youdede-toolkit verify-integrity [id-or-slug] [--json]
```

Short slugs work only when unique. A full id is always unambiguous.

Packs compose procedures, specialists, and lifecycle gates without changing the independent install contract of any member. Required members must share the requested target and scope, and installation plans every member before the first write. Ownership and rollback guarantees are described in [architecture.md](architecture.md).

Use `--dry-run` before installation to resolve the adapter, validate collisions, and list file and settings mutations without writing anything. Combine it with `--json` to receive stable structured output including payload sizes and SHA-256 digests.

## Scope

Project scope resolves from `--cwd` or the current directory. Roots are selected by target, scope, and artifact kind rather than by target alone; [targets.md](targets.md) lists the per-target project and user roots. `doctor` aggregates every active component root, while install and removal mutate only the root owned by the selected artifact. The CLI rejects a target or scope not declared by the artifact adapter.

Codex project-scope hooks are written to `.codex/hooks.json` with the absolute path of the project on the installing machine. Do not commit that file for other machines; reinstall on each machine instead.

## Existing files

The default is conservative. A destination that already exists and is not owned by the same artifact stops installation. A managed payload or managed hook entry whose current content differs from its recorded installation state also stops reinstall or upgrade. `--force` is required to replace either kind of user modification, and it does not delete unrelated siblings. When it replaces an unmanaged regular payload file, the installer records a bounded owner-only backup and restores that exact file on uninstall. Unmanaged files larger than 1 MiB are refused instead of being copied into installation state. A toolkit-created hook settings file is removed when the last owning hook is removed; user-added settings keep the file in place.

Settings are written atomically while preserving an existing file mode. When an existing settings file contains malformed JSON, installation stops without modifying it.

Payload files are hashed while the plan is built and verified again immediately before they are copied. Existing symbolic links inside an installation destination are rejected so adapter paths cannot redirect writes outside the declared root.

Installing writes `<target-root>/.youdede-toolkit/NOTICE.md`, listing every artifact currently installed in that root with its licence and contributors, together with the MIT licence text. It is regenerated on each install and removal and deleted when the last artifact is removed. Keep it while installed payloads are present: it is how the licence notice travels with the copied files.

Bundled artifacts are also checked against `catalog/integrity.json` before planning. Run `verify-integrity` to validate one artifact or the complete catalog. These checksums detect drift relative to the included manifest; authenticate the manifest through the release's signed Git tag and npm provenance. See [integrity.md](integrity.md).

## Trust

Read an artifact before installing it. Hooks and OpenCode plugins execute automatically inside their agent runtime and deserve the same review as build scripts or Git hooks. Run `youdede-toolkit info <artifact>` and inspect its payload, pinned sources, relationship and license, refusal list, stability, and target limitations. Install and dry-run output repeats the automatic-execution, failure-policy, retention, activation, and target-limit disclosure.

## Hook profiles and packs

Choose hooks by the concrete boundary a repository exposes: for example, package publication, infrastructure execution, schema compatibility, or system mutation. The installer guarantees collision-free composition and independent removal, but it intentionally does not install the whole hook catalog as a preset. Every hook whose matcher accepts an event runs as a separate bounded process, so a smaller policy-relevant set gives clearer decisions and lower event latency.

Use a named pack when its documented outcome matches the repository. A pack is not a blanket recommendation: inspect `pack-info`, review every enforcement member, and dry-run the installation first.
