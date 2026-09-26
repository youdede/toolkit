# Changelog

All notable changes are recorded here. Versions follow Semantic Versioning; release entries are derived from reviewed pull requests and verified against the corresponding Git tag.

## Unreleased

### Added

- Three bounded workflow commands cover CI diagnosis, redacted environment preflight, and repository-instruction audits; four generated contexts add API, migration, CI, and dependency baselines at precedences 300–600.
- Preview external MCP profiles pin the official GitHub server `v1.12.2` in read-only reduced-toolset mode and Playwright MCP `0.0.82` in isolated loopback-only mode. They ship in the separate `remote-review-evidence` and `browser-verification` packs rather than widening `mcp-baseline`.

### Changed

- GitHub Copilot skill adapters are now `stable` and name the surfaces GitHub documents for Agent Skills; GitHub's page (read 2026-09-26) has no preview label. Copilot subagent adapters stay `preview` and now name the surfaces where GitHub marks custom agents as public preview: JetBrains IDEs, Eclipse, and Xcode.
- Gemini CLI subagent adapters are now `stable`: the official subagents page (read 2026-09-26) says subagents are enabled by default and no longer calls them preview. Every Gemini CLI adapter, and `docs/targets.md`, now states that Google stopped serving Gemini CLI on 2026-06-18 for free use and for Google AI Pro and Ultra, and that Antigravity CLI, which replaces it for those users, is not a target.
- The npm package no longer contains the `skills/` and `plugins/` marketplace copies, the marketplace manifests, or the README images; native marketplaces read them from the repository. The packed size drops from about 4.8 MB to about 1.4 MB, and the CLI commands behave identically on the extracted package.
- Repository validation rejects a subagent whose body differs between targets, apart from the Copilot turn-budget line.
- Behavioral evaluation coverage now includes every skill, subagent, command, and context. Release benchmark inputs, package verification, readiness counts, catalog documentation, and naming/authoring guidance use the same six-kind model.
- `resume-session-work` is published only for Claude Code. Its Gemini CLI, GitHub Copilot, Cursor, and OpenCode adapters are withdrawn, as the Codex one already was, because the session ledger and its hooks install only for Claude Code; on those runtimes the skill had nothing to read.
- The `mobile-release-readiness` pack summary (1.0.1) states what its release guards stop today: npm, pnpm, yarn, cargo, twine, and `gh release` publication. `fastlane`, `eas submit`, `xcrun altool`, and Gradle publish tasks are not intercepted, and version consistency covers `package.json` and its lockfile, not mobile build numbers.
- Two packs no longer call a subagent that does not verify their outcome a verifier. In `browser-verification` 1.0.1, `web-performance-reviewer` is a specialist and the summary says the change is reviewed for web performance risks, not that the journey is independently re-verified. In `session-continuity` 1.1.0, `decision-record-reviewer` is a specialist mapped to `resumable-work`; `verified-session-history` rests on `verify-session-ledger`, which checks the hash chain.
- Command documentation now states the actual enforcement boundary: deterministic preconditions are a mandatory first prompt action, not a pre-invocation parser supplied by the native slash-command runtime.

### Fixed

- The Claude Code profile of `rag-evaluation-reviewer` no longer lists `NotebookRead`, which is not a Claude Code tool; `Read` already returns notebook cells. Repository validation now rejects any Claude Code subagent tool outside `Read`, `Grep`, and `Glob`.
- The `repository-git-readonly` MCP tools no longer run programs chosen by repository configuration or rewrite `.git/index`: every call passes `--no-optional-locks`, `-c core.fsmonitor=false`, and `-c diff.autoRefreshIndex=false`, and `git_log` passes `--no-show-signature`. Before, `git_status` and `git_diff` ran `core.fsmonitor` and refreshed the index, and `git_log` ran `gpg.program` when `log.showSignature` was set. `git_status` and `git_diff` also refuse to run when the Git configuration defines a filter driver other than the standard Git LFS commands, because Git would run it; before, any configured filter driver ran.
- `commit-guard` now scans the working tree when the same command stages content or the commit takes content from the working tree (`-a`, pathspecs, `--include`, `--only`). Before, `git add .env && git commit` and `git commit -am` were allowed because the index was inspected before the staging ran.
- `protected-branch-guard` resolves a bare `git push` through Git's own `@{push}` and blocks only a protected destination; it expands Git aliases once, treats refspecs on remotes with a `remote.<name>.push` mapping as uninspectable, and blocks `send-pack` and command runners (`xargs`, `find -exec`) that start a relevant Git subcommand. Before, an alias or a push mapping could force-push to `main`.
- The read-only MCP runtime refuses credential files (`.env`, private keys, cloud credentials) that its profiles declare no access to. Before, `read_file` returned `.env` content.
- `sensitive-file-access-guard` blocks recursive searches, archives, and copies whose directory contains a protected file. Before, `grep -r KEY .` printed `.env`. The Claude Code Grep tool and `rg` honour `.gitignore` (unless `-u`, `-uu`, `--no-ignore`, or `--no-ignore-vcs` is given), so the guard asks Git for the non-ignored files in those cases; an ignored `.env` no longer blocks them. The guard now runs a bounded `git` subprocess, so its latency class is `bounded`.
- The read-only MCP runtime negotiates `protocolVersion` against the versions it implements (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`) instead of echoing any value, and answers unparsable JSON with `-32700`. JSON-RPC batches, required by `2025-03-26`, are still refused.
- Removing the last artifact from an install root now deletes the empty installer state, and the state lock retry is bounded by the lock timeout.
- The release workflow publishes the exact commit the `verify` job inspected rather than re-resolving the tag.
- Documentation claims now match verified behavior: hooks are described as mostly blocking with a few observers; the eval, authoring, context-expiry, pack-evidence, plugin-count, CLI-syntax, branch-policy, and tag-immutability statements were corrected; and a duplicated row was removed from the 2026-09-23 risk and latency audit.
- `add --dry-run` now lists `.youdede-toolkit/NOTICE.md`, which the real install writes; the JSON plan gains a `notice` entry. Before, the dry-run omitted that file.
- The API, migration, CI, and dependency contexts install for Cursor in `.cursor/rules/` and for GitHub Copilot in `.github/instructions/`. Before, they landed in `.cursor/.cursor/rules/` and `.github/.github/instructions/`, where neither runtime reads them.
- `plan-and-verify-loop` 1.1.0 includes `coding-style-baseline`, which `draft-evidenced-plan` requires as its precondition. Before, the command refused to run right after `add-pack plan-and-verify-loop`. Evidence reports for the `evidenced-plan` outcome now cite that member too.
- The command precondition bridge reports a required file under a missing directory as `missing`. Before, `file-exists` called it `path escapes the workspace`, so `draft-evidenced-plan` gave a false security diagnosis when its baseline context was not installed.
- `re-pin-mcp-tools` builds its proposal from the repository's current `catalog/mcp-pins.json` and no longer installs a copy of it. Before, the installed copy went stale after the first re-pin, so `previousTools` and the confirmation digest were computed against old pins.
- `record-work-checkpoint` now says the ledger bridge rejects the whole checkpoint when a touched path is absolute or escapes the repository. Before, it said such paths were dropped.
- Six review subagents (`web-performance-reviewer`, `test-gap-reviewer`, `application-security-reviewer`, `migration-risk-reviewer`, `accessibility-conformance-reviewer`, `release-risk-reviewer`) ask for one uncertainty section and name their scope section `## Scope reviewed`. Before, some contracts required two uncertainty sections, and all six required `## Scope`, the name of the brief's own input section, so refusals had no declared place. The output-contract validator now rejects both patterns in subagents.
- `decision-record-reviewer` no longer tells the reviewer to "say only" that a record is reconstructable when nothing is found; it names the records inspected, as the no-finding rule later in the same brief requires.
- The `testing`, `git-workflow`, `security`, and `coding-style` baselines state their forbid rules as prohibitions (for example "Do not edit generated files directly; change the generator or its source template and regenerate."). Before, the generator copied a hook refusal that describes what the hook does not do, so the rules forbade running or repairing tests, any branch or commit, reading any local file, and editing the source template. A context rule sourced from a refusal now needs its own `text`.
- The `playwright-local-isolated` threat notes match upstream `@playwright/mcp` 0.0.82: `--allowed-hosts` restricts the hosts the HTTP transport serves from, not browser navigation, and the exposed `browser_file_upload` tool can upload files under the workspace root, so callers must not call it. Before, the notes said both flags restricted browsing to `127.0.0.1` and that no upload path existed.
- `verify-claims-against-output` defines when a claim is flaky without asking for a rerun, and `audit-release-evidence` prints its JSON report in the reply. Before, the first reported "both hashes" of a command it forbade rerunning, and the second printed the path of a file it had no tool to write.
- Twelve subagents name their actual map or matrix heading in the no-finding instruction instead of an "evidence map" section none of them declares. `numerical-correctness-analyst` and `incident-timeline-analyst` no longer carry an ungrammatical severity threshold ("outside no stated tolerance", a doubled "only when").
- `test-gap-reviewer` and `dependency-risk-reviewer` no longer describe themselves as Claude Code specialists; both ship for four runtimes. `accessibility-conformance-reviewer` no longer implies it can certify WCAG given enough evidence; like its brief, it refuses certification from a bounded review.

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

- Repository governance, deterministic commit and branch policy, versioned Git hooks, SHA-pinned Linux CI, contribution templates, and reproducible protection settings.
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
