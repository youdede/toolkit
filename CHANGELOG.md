# Changelog

All notable changes are recorded here. Versions follow Semantic Versioning; release entries are derived from reviewed pull requests and verified against the corresponding Git tag.

## Unreleased

### Added

- Three bounded workflow commands cover CI diagnosis, redacted environment preflight, and repository-instruction audits; four generated contexts add API, migration, CI, and dependency baselines at precedences 300–600.
- Preview external MCP profiles pin the official GitHub server `v1.12.2` in read-only reduced-toolset mode and Playwright MCP `0.0.82` in isolated loopback-only mode. They ship in the separate `remote-review-evidence` and `browser-verification` packs rather than widening `mcp-baseline`.

### Changed

- The npm package no longer contains the `skills/` and `plugins/` marketplace copies, the marketplace manifests, or the README images; native marketplaces read them from the repository. The packed size drops from about 4.8 MB to about 1.4 MB, and the CLI commands behave identically on the extracted package.
- Repository validation rejects a subagent whose body differs between targets, apart from the Copilot turn-budget line.
- Behavioral evaluation coverage now includes every skill, subagent, command, and context. Release benchmark inputs, package verification, readiness counts, catalog documentation, and naming/authoring guidance use the same six-kind model.
- Command documentation now states the actual enforcement boundary: deterministic preconditions are a mandatory first prompt action, not a pre-invocation parser supplied by the native slash-command runtime.

### Fixed

- `commit-guard` now scans the working tree when the same command stages content or the commit takes content from the working tree (`-a`, pathspecs, `--include`, `--only`). Before, `git add .env && git commit` and `git commit -am` were allowed because the index was inspected before the staging ran.
- `protected-branch-guard` resolves a bare `git push` through Git's own `@{push}` and blocks only a protected destination; it expands Git aliases once, treats refspecs on remotes with a `remote.<name>.push` mapping as uninspectable, and blocks `send-pack` and command runners (`xargs`, `find -exec`) that start a relevant Git subcommand. Before, an alias or a push mapping could force-push to `main`.
- The read-only MCP runtime refuses credential files (`.env`, private keys, cloud credentials) that its profiles declare no access to. Before, `read_file` returned `.env` content.
- `sensitive-file-access-guard` blocks recursive searches, archives, and copies whose directory contains a protected file. Before, `grep -r KEY .` printed `.env`. The Claude Code Grep tool and `rg` honour `.gitignore` (unless `-u`, `-uu`, `--no-ignore`, or `--no-ignore-vcs` is given), so the guard asks Git for the non-ignored files in those cases; an ignored `.env` no longer blocks them. The guard now runs a bounded `git` subprocess, so its latency class is `bounded`.
- The read-only MCP runtime negotiates `protocolVersion` against the versions it implements (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`) instead of echoing any value, and answers unparsable JSON with `-32700`. JSON-RPC batches, required by `2025-03-26`, are still refused.
- Removing the last artifact from an install root now deletes the empty installer state, and the state lock retry is bounded by the lock timeout.
- The release workflow publishes the exact commit the `verify` job inspected rather than re-resolving the tag.
- Sixteen skills asked for their own instruction sections (`## Contract`, `## Validation`, `## Stop conditions`, `## Refusals`) as reply headings, so no heading held the deliverable. Their output contracts now name the work product (for example `## Questionnaire`, `## Work graph`, `## Disposition`), and `check:contracts` rejects a contract that names the payload's `## Contract`, `## Workflow`, or `## Refusals` section.
- The `enforce-typescript-module-boundaries` skill told agents to pass one package root to `--root`; the helper expects the directory that contains the packages, so it reported imports between a package's own folders as cross-package violations. The skill now says so, and the helper also flags a two-segment deep import such as `../b/src` (only `<pkg>` and `<pkg>/index` count as the entry point).
- The `review-database-migration-plan` SQL helper treated a backslash as an escape in every string, so `'C:\'` hid a following `DROP TABLE`. It now follows PostgreSQL's default `standard_conforming_strings` (backslash escapes only in `E'...'`), no longer reports `ON UPDATE SET NULL` as an UPDATE without WHERE, and reports an UPDATE or DELETE whose only WHERE is inside a subquery.
- `write-compliant-cold-email` did not require the sender's physical postal address, which CAN-SPAM requires in every commercial email to US recipients, business-to-business included (FTC compliance guide, August 2023, edited January 2024). The skill now asks for it and checks it; its minimum inputs also include the evidence behind personalization and claims, which its stop condition already required.
- `build-compliant-prospect-list` and `build-sales-enablement-asset` let an agent pass their minimum-input gate without the target situation (prospect list) or the buyer and deal stage (sales asset), which their own workflow and stop conditions require. Both gates now ask for them.
- The `review-ci-workflow-change` collector missed `pull_request_target` and other events declared under a block `on:` (or a quoted `"on":`), `secrets: inherit`, `github.token`, `contents: read`, and the commands inside `run: |` blocks, and reported `- name: Pre-run: ...` as a run command. It now reports them, and the skill lists what the collector covers.
- The `review-supply-chain-change` collector aborted the whole run on any file over an undocumented 512 KiB limit, which real `package-lock.json` files often exceed; one file may now use the full 4 MiB budget. It also reports `prepublish`, `preprepare`, and `postprepare` (all run by `npm install`), reads `{ uses: ... }` and folded `uses: >-` workflow references, and marks recognized but uninspected files such as `pyproject.toml` with `analyzed: false`.
- The `review-schema-evolution` helper produced no signal for changes to keywords outside its fixed list, such as `unevaluatedProperties` turning false, `dependencies`, `additionalItems`, or `$schema`, so `signalCount: 0` could hide a restrictive change. It now reports any other differing keyword as `SCHEMA_KEYWORD_CHANGED` (documentation keywords excepted) and lists this in its limitations.
- The `author-guided-setup-wizard` validator accepted a wizard that read a token with visible input and passed it to `curl` on the command line, accepted the word "confirmation" in a comment as a confirmation gate, and rejected `set -e # never set -x`. It now ignores comments, flags secret-like variables read without `-s` or expanded in network and client commands, and the skill states that the checks are lexical.
- `decompose-dependent-work-slices` did not document the JSON its graph validator expects (`tickets` with `id`, `title`, `blockedBy`), so a graph written from the skill's own field list was rejected, and it gave a path relative to the skill folder. The skill now shows the format and the `<skill-root>` path, and the validator no longer reports a dependency cycle for a missing blocker or a self-block.
- Six skills told the agent to run `node scripts/...` from the installed skill folder, which fails from the project directory where agents run commands (and, for `extract-youtube-captions`, wrote relative outputs inside the installed skill). They now use `node "<skill-root>/scripts/..."` like the other skills. The `build-progressive-learning-exercises` plan validator also reports a non-object exercise as an error instead of crashing with a stack trace.
- The `author-effective-agent-skill` validator rejected skills that follow the Agent Skills specification: the optional `license`, `compatibility`, `metadata`, and `allowed-tools` fields, folded (`>-`) descriptions, and CRLF files. It now accepts them, and the skill names the two checks that are this catalog's conventions rather than the specification's.
- `design-interface-feedback` classified a specification built on estimated budgets both as applying and as reduced scope; applying now requires every budget to rest on named duration evidence.

## 0.3.0 (2026-09-21)

### Added

- Three new artifact kinds extend the catalog contract: `command` (user-invoked workflows with a declared tool allowlist, invocation preconditions, required evidence output, and flags that may only narrow authority), `context` (scoped rule files with precedence, optional expiry, and provenance links to the catalog artifacts each rule descends from), and `mcp-server` (vetted tool-server configurations with declared transport, network egress, secret access, trust boundary, and a pinned tool manifest for capability-drift detection). The taxonomy gains the `development/workflow` and `operations/session` categories, packs gain the `entrypoint`, `baseline`, and `integration` member roles, and the repository validator enforces every kind-specific contract.
- `command/development/workflow/draft-evidenced-plan` is the first command artifact: a slash-invoked planning workflow whose every step cites read files and the verification that proves it, gated by the new shared precondition bridge `scripts/runtime/command-precondition.mjs` (bounded git-clean, file-exists, and evidence-valid checks, workspace-escape and symlink safe). Command artifacts require a `COMMAND.md` payload whose `allowed-tools` frontmatter must match the declared `toolAuthority`, at least three documented refusals, a `preconditions.json`, and adapter destinations under `commands/`.
- `docs/catalog/` gains generated command, context, and MCP server pages, and the README coverage matrix plus `docs/targets.md` report all six kinds per runtime.
- `hook/development/workflow/phase-gate-guard` enforces the `spec → design → tasks → implementation` evidence chain: a phase file under the reserved `.youdede/phases/` directory may be written only when its predecessor exists, parses, and carries a matching phase, a real summary, and non-empty anchors. Unknown filenames, malformed evidence, and symlinked or oversized predecessors block; anything outside the directory is never inspected.
- `command/development/workflow/verify-claims-against-output`, `assemble-review-brief`, and `audit-release-evidence` complete the first command tranche: claim verification with hashed command output on clean worktrees only, review-brief assembly from the real diff with mandatory uncovered-areas reporting, and release-evidence audit emitting a machine-readable verdict report. The validator now also rejects duplicate flag names within one command manifest.
- Deterministic session continuity adds a 1 MiB append-only, hash-chained ledger with Git anchors, secret-shape redaction, concurrent-writer locking, a 30-day restore horizon, and integrity verification that covers nested anchor fields. Three fail-open hooks checkpoint session ends, restore a bounded verified tail, and warn before compaction; two commands record and verify checkpoints; `resume-session-work` resumes only with hash-cited claims; and `tool-output-budget-guard` makes oversized tool output visible without echoing it.
- Four generated context baselines cover coding style, testing, Git workflow, and security for Claude Code, Cursor, and GitHub Copilot. Their native rule files are regenerated from catalog summaries and refusals, carry exact source IDs, preserve deterministic precedence through numeric filenames, warn after expiry, and refuse install-set contradictions with hooks through named action contracts.
- Three curated project-scoped MCP servers provide bounded workspace-file, local-Git, and allowlisted-document reads for Claude Code and Cursor through a shared local Node.js stdio runtime. Profiles declare exact egress and secret authority, pin tool-description hashes, include threat notes, and are checked for launch drift and prompt-poisoning patterns. Native `.mcp.json` and `.cursor/mcp.json` entries merge and remove reversibly, `doctor` detects configuration drift, `mcp-capability-drift-guard` fails closed on unknown or changed toolkit capabilities, and `re-pin-mcp-tools` requires an exact human-confirmed proposal digest plus review evidence.
- Four workflow packs raise the catalog to eleven compositions: `plan-and-verify-loop`, `session-continuity`, `daily-driver`, and `mcp-baseline`. Every pack now has a semantic version, an explicit outcome-to-member evidence map, four generated behavioral scenarios, and a bounded ledger-linked report contract verifiable with `verify-pack-evidence`; the release, review, and secure-boundary packs also gain their command or MCP guard entrypoints.
- Native Claude Code and Codex marketplaces are generated from catalog contracts and checked for byte drift. Claude Code receives ten complete pack plugins with exact refusal counts and evidence badges; the context-dependent `plan-and-verify-loop` is explicitly withheld rather than weakened. Codex receives all 166 supported skills while unsupported artifact kinds remain named in a machine-readable compatibility report; `resume-session-work` is withheld because its verified ledger runtime is Claude-only.
- A generated capability matrix maps all six artifact kinds and eleven packs to their manifest-enforced guarantees, observed failure policies, native adapter coverage, common install coordinates, evidence contracts, and claim boundaries. CI refuses documentation drift, and the core behavioral-evaluation suite now requires every pack's four ledger-linked evidence scenarios.
- Eighteen design skills covering research synthesis, journey mapping, design direction, information architecture, visual layout, color, typography, UI critique, forms, interface feedback, navigation and search, onboarding, design tokens, component contracts, design-system governance, engineering handoff, responsive behavior, and localization. The design taxonomy gains the `strategy` and `visual-design` categories, and the approved skill-slug verb list gains seven action verbs.
- A deterministic, value-redacting secret scanner checks tracked and publishable files on every validation run and scans the complete reachable Git history before a release.

### Changed

- The installer permits multiple artifacts to own a byte-identical shared runtime file while retaining collision refusal for different bytes or executable modes; removing one owner preserves the shared file until its final owner is removed.
- The `Protect main` ruleset no longer requires an approving review: only people with write access can merge, so the requirement never gated external contributions and only blocked the sole code owner's own pull requests. Pull requests, squash-only merges, signed commits, linear history, resolved review threads, and the `quality-gate` status check remain required.
- The npm release workflow is manual-only, requires an exact package-and-tag confirmation, uses the supported Node 24 trusted-publishing runtime, and fails before checkout while the source repository is private and provenance is unavailable.

### Fixed

- Installed command and hook entrypoints now detect direct execution through canonical filesystem paths, including macOS `/var` → `/private/var` aliases used by temporary workspaces.
- Documentation statistic checks now require the exact marker inventory for every managed file, so deleting, duplicating, renaming, or unbalancing one marker cannot silently bypass drift detection.
- Release governance no longer claims that the private GitHub Pro environment has an unavailable required-reviewer gate or that a private source repository can produce npm provenance.

## 0.2.0 (2026-08-26)

### Added

- `skill/design/accessibility/verify-cognitive-access-barriers` verifies consistent help (WCAG 2.2 SC 3.2.6), redundant entry (3.3.7) and accessible authentication (3.3.8) against an observed walkthrough, and records the reading, recovery and time demands no criterion measures.
- `skill/design/accessibility/prepare-eaa-conformance-evidence` maps accessibility results to the requirement set and version an owner declared, marking each verified, asserted, stale, not applicable, exempt with assessment or absent. It does not decide whether a law applies, nor declare conformity.
- `hook/design/authentication-access/authentication-accessibility-guard` blocks an edit that newly stops paste on a credential field, disables its autofill, drops its autocomplete token, or adds a password-manager opt-out attribute. W3C documents each as failing SC 3.3.8.
- `accessibility-attribute-regression-guard` gains two rules: `aria-hidden="true"` or `role="presentation"` on a focusable element, and a viewport meta that suppresses zoom, which is W3C ACT rule b4f0c3 for SC 1.4.4.
- `docs/catalog/` lists every artifact with what it does, its risk, and the runtimes that carry it. The pages are generated from `catalog/artifacts.json` and `npm run check` fails when they drift.
- The semantic release receipt is published at `quality/release-evidence/`, so `npm run check:readiness` can verify a release from a clean clone.
- `.github/allowed-signers` declares the public keys trusted to sign a release tag, so `git verify-tag` in CI can attribute a signature to a named identity.
- `npm run check:changelog` refuses a build whose `package.json` version has no populated section in this file, and the release workflow refuses a tag that is not documented here.

### Changed

- The `Protect main` ruleset requires one approving review from a code owner, dismisses stale reviews on push, and requires approval of the last push. `CODEOWNERS` was declared but never enforced. The repository admin role bypasses the review requirement on pull requests only, so a sole code owner is not blocked on their own work.
- `plan-accessibility-conformance-evidence` names single-pointer alternatives to dragging among its evidence methods, covering SC 2.5.7.
- The accessibility pack carries nine artifacts instead of six, and every member composes with the rest.
- The release receipt covers 210 static payloads and 890 dynamic cases, with zero confirmed defects and calibration at 100% on both axes.

### Fixed

- `accessibility-attribute-regression-guard` compared elements with no `id`, test id or `name` by their position among siblings of the same tag, so inserting a button above another read as stripping the second one's relationships. Those elements are now judged by how many of their kind carry a name or a relationship.
- Both markup guards ended an element at the first `>`, which in JSX falls inside an arrow function, hiding every attribute written after a handler. Tags now end at the first `>` outside quotes and braces.

## 0.1.0 (2026-08-25)

### Added

- Repository governance, deterministic commit and branch policy, versioned Git hooks, pinned cross-platform CI, contribution templates, and reproducible protection settings.
- Public artifact-integrity attestations and semantic release-readiness evidence controls for the planned `0.1.0` release.
- `npm run check:contracts` fails the build when a prompt payload's output contract disagrees with the payload's own text or with its behavioral cases, covering heading membership, ordering, unresolvable section references, and duplicates.
- `npm run benchmark:release:build -- --full` evaluates every candidate behavioral case instead of the stratified sample. The release gate rebuilds using the policy recorded in the benchmark and refuses a policy that would sample less than the release minimum.
- A release workflow that publishes from a protected environment using npm trusted publishing, after verifying a signed annotated tag, a matching package version, and both release gates.

### Changed

- Expanded the catalog to 264 artifacts and seven outcome packs across six coding-agent runtimes.
- Every prompt-bearing artifact now states one unconditional output contract: the headings to return on every path, including when it declines or lacks inputs.
- Behavioral response checking no longer grades a self-reported disposition, and `requiredEvidence` phrases are reported as reviewer advice rather than enforced as literal substrings.
- Forbidden-phrase detection is scoped to the sentence rather than a fixed window, so a refusal or a report of what was requested no longer counts as an assertion. One guard governs every clearing rule: a first-person completed claim after a refusal is still a violation.

### Fixed

- Twelve guards and helper scripts passed their environment straight to `git`, so an inherited `GIT_DIR` made them inspect a repository other than the one they were pointed at, and report the result as if it came from the project in front of them. They now strip every `GIT_*` variable, matching the convention `protected-branch-guard` already used.
- `remove --force` resolved the hook marker from the entry being removed rather than from recorded state, so a forced removal could delete a marker it never installed.
- Concurrent installs shared no lock, and a refused install created a configuration root as a side effect.
- Subagent validation assumed a single target shape and rejected targets that identify an agent by filename.
- Unknown command-line flags were accepted silently.

### Removed

- Authoring research snapshots and origin-tracing records from the publishable repository surface.
