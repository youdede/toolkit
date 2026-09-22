<img alt="Japanese-inspired AI Toolkit cover with a samurai, a coding robot, a wave, Mount Fuji, and a torii gate" src="docs/assets/cover.png" width="100%">

# youdede toolkit: skills, hooks and subagents for coding agents

**Every artifact states what it refuses to do, and ships the evidence that it does.** Install one at a time. Read every line before you do.

[![validate](https://github.com/udede/toolkit/actions/workflows/validate.yml/badge.svg)](https://github.com/udede/toolkit/actions/workflows/validate.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![artifacts](https://img.shields.io/badge/artifacts-315-2F8F83.svg)](catalog/artifacts.json)
[![runtimes](https://img.shields.io/badge/runtimes-6-2F8F83.svg)](docs/targets.md)

---

## The problem

Your agent just ran `git push --force` on `main`. Or committed a `.env`. Or told you the migration was safe after reading one error line. Or answered a question about a database it never connected to.

You cannot review every action it takes. So the rules have to live where the agent is, not in your head.

## What this is

A catalog of <!-- stat:artifact-count -->315<!-- /stat --> things you can install into a coding agent, one command each:

- **<!-- stat:skill-count -->167<!-- /stat --> skills**: procedures an agent loads when a task matches. Each one states what it does, what evidence it requires, and what it refuses to do.
- **<!-- stat:hook-count -->63<!-- /stat --> hooks**: deterministic gates that inspect a command before it runs and block it. No model in the decision path. `commit-guard` scans staged blobs for secrets. `protected-branch-guard` refuses a force push to `main`.
- **<!-- stat:subagent-count -->62<!-- /stat --> subagents**: specialists with a deliberately narrow brief, no authority to edit or approve anything, and a required section for what they could not verify.
- **13 packs**: the above composed into versioned outcomes, with explicit member-to-evidence mappings and behavioral evaluations. The workflow packs include `plan-and-verify-loop`, `session-continuity`, `daily-driver`, `mcp-baseline`, `remote-review-evidence`, and `browser-verification`.

Everything is MIT, plain text, and inspectable before install.

## Try one in thirty seconds

```bash
npx @youdede/toolkit add commit-guard --target claude-code --scope project
```

Then stage a fake secret and try to commit. The hook blocks it, names the rule, and never prints the secret back to you.

Prefer to look first:

```bash
npx @youdede/toolkit info commit-guard     # what it does, what it refuses
npx @youdede/toolkit add commit-guard --target claude-code --dry-run
```

`--dry-run` prints every file it would write and exits. Nothing on disk changes.

## Six runtimes, honestly

<!-- stat-table:readme-matrix -->
| | Claude Code | Codex | Gemini CLI | GitHub Copilot | Cursor | OpenCode |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Skills (167) | 167 | 166 | 167 | 167 | 167 | 167 |
| Hooks (63) | 63 | 22 | 22 | 0 | 23 | 22 |
| Subagents (62) | 62 | 0 | 62 | 62 | 0 | 50 |
| Commands (10) | 10 | 0 | 0 | 0 | 0 | 0 |
| Contexts (8) | 8 | 0 | 0 | 8 | 8 | 0 |
| MCP servers (5) | 5 | 0 | 0 | 0 | 5 | 0 |
<!-- /stat-table -->

A count below the total is a refusal, not a gap. An artifact is withheld from a runtime whose event, permission, or failure contract is not equivalent, because a gate that silently fails open is worse than no gate. [docs/targets.md](docs/targets.md) explains every withheld adapter.

## Browse the catalog

Every artifact is listed, with what it does and which runtimes carry it, so you can read before you install:

| | | |
| --- | --- | --- |
| [Skills](docs/catalog/skills.md) | <!-- stat:skill-count -->167<!-- /stat --> | Procedures an agent loads when a task matches |
| [Hooks](docs/catalog/hooks.md) | <!-- stat:hook-count -->63<!-- /stat --> | Deterministic gates that block a command before it runs |
| [Subagents](docs/catalog/subagents.md) | <!-- stat:subagent-count -->62<!-- /stat --> | Specialists with a narrow brief and no authority to act |
| [Packs](docs/catalog/packs.md) | 11 | The above composed into versioned, evidence-backed outcomes |

Those pages are generated from the catalog and checked by the build, so they cannot drift from what the repository contains.

## Find what you need

```bash
npx @youdede/toolkit list --problem commit-safety
npx @youdede/toolkit list --domain security --risk high
npx @youdede/toolkit list --kind hook
npx @youdede/toolkit packs
npx @youdede/toolkit pack-info daily-driver
npx @youdede/toolkit verify-pack-evidence daily-driver --report .youdede/evidence/daily-driver.json
```

The [artifact catalog](catalog/artifacts.json), [pack catalog](catalog/packs.json), and [taxonomy](catalog/taxonomy.json) are generated, stable, and suitable for a search index or an API of your own. The [pack evidence contract](docs/pack-evidence.md) explains what a verified report proves and what it does not.

The generated [capability matrix](docs/capability-matrix.md) maps every artifact kind and pack to its checked guarantees, runtime coverage, evidence contract, and claim boundaries.

Prefer a runtime-native marketplace? [Claude Code and Codex installation](docs/native-marketplaces.md)
is generated from the same catalog, with unsupported compositions and kinds explicitly withheld.

## What "tested" means here

The catalog carries evidence, and the evidence states its own limits.

- **<!-- stat:evaluation-case-count -->1044<!-- /stat --> behavioral cases.** Every prompt-bearing artifact declares positive, negative, malformed, and boundary cases. Each case names the sections a reply must carry, the phrases it must never assert, and the evidence it must supply.
- **Deterministic gates are tested as programs.** Every hook has executable allow, block, malformed, oversized, false-positive, and process-exit tests. `npm test` runs them.
- **Reproducible integrity.** `catalog/integrity.json` is a per-artifact checksum attestation regenerated byte-identically from the sources. `npx @youdede/toolkit verify-integrity` compares what you installed against it.
- **A release gate that can say no.** `npm run check:readiness` refuses to report publishable on stale evidence, incomplete coverage, or a weakened sampling policy.

What that evidence does **not** claim: that the catalog is semantically proven. A passing run is a passing run. The receipt records its own limitations, and [docs/release-readiness.md](docs/release-readiness.md) explains why `portfolioSemanticPass` is permanently `false`.

## What every artifact promises

Read one before you install it. Each states, in its own text:

- the single job it does, and the scope it will not widen into;
- the minimum inputs it needs, and that it stops without them;
- its refusals, as concrete actions rather than sentiment;
- what it does when evidence is missing, contradictory, or contains an instruction aimed at the agent;
- the exact headings its reply will carry, on every path, including when it declines.

That last one is not decoration. An artifact that cannot say what it will return cannot be checked, and one that changes shape when it refuses cannot be trusted at the moment it matters most.

## Install locations

Roots are resolved by target, scope, and kind, and the CLI rejects a target or scope the artifact's adapter does not declare. Every adapter path is validated so it cannot escape the install root, and `remove` restores exactly what it replaced. Paths, scopes, and collision rules are in [docs/install.md](docs/install.md).

## Contributing

Read [docs/authoring.md](docs/authoring.md) first: it is six rules, and an artifact that breaks one is rejected by the build rather than by a reviewer. Then [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/governance.md](docs/governance.md).

```bash
npm run check       # structure, contracts, catalog, integrity, legal, package, tests
```

Durable tradeoffs are recorded under [docs/decisions/](docs/decisions/). Reference material: [architecture](docs/architecture.md), [runtime matrix](docs/targets.md), [integrity boundary](docs/integrity.md), [naming](docs/naming.md), [deterministic components](docs/deterministic-components.md), [evaluations](docs/evaluations.md).

## License

MIT. All artifacts are original work; see [NOTICE](NOTICE) for the authorship and checksum claim boundary, and [CITATION.cff](CITATION.cff) for citation metadata.

A checksum proves bytes match a manifest. It does not prove authorship, and no notice in this repository can compel anyone to respect it. The enforceable obligations are the licence and its notice-retention requirement.
