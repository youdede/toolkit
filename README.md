# youdede toolkit

[![validate](https://github.com/udede/toolkit/actions/workflows/validate.yml/badge.svg)](https://github.com/udede/toolkit/actions/workflows/validate.yml)

**Open tools for coding agents. Free, inspectable, and installable one at a time.**

A procedure an agent can load, a deterministic gate that stops a dangerous commit, or a specialist with a deliberately narrow brief. Every artifact states what it does, what it refuses to do, which runtimes it supports, and where its ideas came from.

The same catalog now targets Claude Code, Codex, Gemini CLI, GitHub Copilot, Cursor, and OpenCode. Support is capability-specific rather than cosmetic: portable skills cover all six runtimes, specialist profiles are emitted only where their authority can be preserved, and deterministic gates are withheld whenever an event or failure contract is not equivalent.

The current catalog contains 264 independently installable artifacts: 146 skills, 56 hooks, and 62 subagents, plus 7 cross-kind outcome packs. Source audits feed a classified backlog; overlapping, unsafe, tool-bound, or excessively broad items are consolidated, narrowed, validated further, or excluded rather than mirrored.

## Install one artifact or a composed pack

From this checkout:

```bash
node ./bin/youdede-toolkit.mjs list
node ./bin/youdede-toolkit.mjs info debug-systematically
node ./bin/youdede-toolkit.mjs add debug-systematically --target claude-code --scope project --dry-run
node ./bin/youdede-toolkit.mjs add debug-systematically --target claude-code --scope project
node ./bin/youdede-toolkit.mjs packs
node ./bin/youdede-toolkit.mjs add-pack accessibility-assurance --target claude-code --scope project --dry-run
```

After the npm package is published, the same operation is one line:

```bash
npx @youdede/toolkit add debug-systematically --target claude-code --scope project
npx @youdede/toolkit add debug-systematically --target codex --scope project
npx @youdede/toolkit add shell-command-guard --target codex --scope project
npx @youdede/toolkit add debug-systematically --target gemini-cli --scope project
npx @youdede/toolkit add debug-systematically --target github-copilot --scope project
npx @youdede/toolkit add debug-systematically --target cursor --scope project
npx @youdede/toolkit add debug-systematically --target opencode --scope project
npx @youdede/toolkit add-pack accessibility-assurance --target claude-code --scope project
```

Use `--scope user` when the chosen adapter exposes a personal installation. Roots are resolved by target, scope, and artifact kind: for example, Codex skills use `.agents`, while Codex hooks use `.codex`. Hooks remain project-scoped except for OpenCode's native local-plugin adapter. See the exact [runtime matrix](docs/targets.md) before assuming that a kind is portable to a target.

Install only the hooks that protect boundaries present in the project. Every supported hook composes without settings collisions, but installing a complete target tranche is a compatibility test rather than a recommended runtime profile: each matching event launches every installed matching gate.

Remove only what the toolkit installed:

```bash
node ./bin/youdede-toolkit.mjs remove debug-systematically --target claude-code --scope project
node ./bin/youdede-toolkit.mjs remove-pack accessibility-assurance --target claude-code --scope project
```

Use `--dry-run` to validate collisions and print every planned mutation without writing. Add `--json` for a machine-readable plan containing the byte count and SHA-256 digest of each payload. The installer verifies the artifact's public attestation before planning and prints automatic-runtime and target-limit disclosures. It refuses to overwrite unmanaged files or modified managed payloads unless `--force` is explicit; bounded unmanaged replacements are backed up for uninstall. It also rejects adapter payload or destination paths that traverse symbolic links. Hook settings are merged into the target's native file while preserving its mode, and owner-only install state is recorded under `<target-root>/.youdede-toolkit/state.json`.

Verify all artifact and shared runtime bytes against the deterministic public manifest:

```bash
node ./bin/youdede-toolkit.mjs verify-integrity
```

## Browse by problem

```bash
node ./bin/youdede-toolkit.mjs list --kind hook
node ./bin/youdede-toolkit.mjs list --capability verify
node ./bin/youdede-toolkit.mjs list --problem commit-safety
node ./bin/youdede-toolkit.mjs list --framework nextjs
node ./bin/youdede-toolkit.mjs list --domain security
node ./bin/youdede-toolkit.mjs list --category agent-orchestration
node ./bin/youdede-toolkit.mjs list --lifecycle release --risk high
node ./bin/youdede-toolkit.mjs list --execution hybrid
```

The generated [artifact catalog](catalog/artifacts.json) and [pack catalog](catalog/packs.json) are suitable for a website, search index, or API. The [taxonomy](catalog/taxonomy.json) separates kind, controlled capability, domain, category, problem, framework, language, lifecycle, risk, target, and scope.

Artifacts also declare `prompt`, `hybrid`, or `deterministic` execution. Hybrid helpers are bundled through the same adapter, so an artifact still installs with one command and no separate script setup.

## Repository layout

```text
artifacts/<kind>/<domain>/<category>/<slug>/
  artifact.json                  canonical metadata
  adapters/<runtime>.json        install mapping for one runtime
  SKILL.md / targets/...         canonical or runtime-specific payload
catalog/
  taxonomy.json                  controlled vocabulary
  artifacts.json                 generated public index
  packs.json                     generated composition index
  integrity.json                 reproducible per-artifact attestations
packs/<slug>/pack.json           cross-kind outcome composition
schema/
  artifact.schema.json           machine-readable contract
  pack.schema.json               composition contract
scripts/
  validate.mjs                   structural and safety checks
  generate-catalog.mjs           deterministic index generation
bin/
  youdede-toolkit.mjs            dependency-free installer
```

Read [the architecture](docs/architecture.md), [runtime matrix](docs/targets.md), [integrity and authorship boundary](docs/integrity.md), [release-readiness contract](docs/release-readiness.md), [naming contract](docs/naming.md), [deterministic component contract](docs/deterministic-components.md), [artifact authoring rules](docs/authoring.md), and [installation details](docs/install.md) before contributing.

Repository changes follow the documented [governance and evidence controls](docs/governance.md), [contribution workflow](CONTRIBUTING.md), and [security policy](SECURITY.md). Durable tradeoffs are recorded under [`docs/decisions/`](docs/decisions/).

## Quality bar

An artifact is publishable only when it:

- has a unique stable id and a semver version;
- declares granular taxonomy values and supported scopes;
- documents explicit refusals and failure behavior;
- matches its deterministic public integrity attestation;
- is original work published under the toolkit's MIT license;
- contains a target adapter whose paths cannot escape the install root;
- packages every declared deterministic entrypoint through every supported adapter;
- has no duplicate identity or installation destination;
- passes manifest, payload, hook, catalog, and installer round-trip tests.

Run everything with:

```bash
npm run check
```

## License

All artifacts are original work published under the MIT license. See [NOTICE](NOTICE) for the authorship and checksum claim boundary and [CITATION.cff](CITATION.cff) for citation metadata.
