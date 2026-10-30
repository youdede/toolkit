# Changelog

All notable changes are recorded here. Versions follow Semantic Versioning; release entries are derived from reviewed pull requests and verified against the corresponding Git tag.

## Unreleased

### Added

- Every Claude Code plugin folder ships a `README.md` that lists its members and states what it runs, so each plugin can be submitted to the Claude plugin directory.

## 0.4.0 (2026-10-30)

### Added

- `npm run release:prepare` derives the next version from the Conventional Commits since the last release and updates the changelog, `package.json`, `package-lock.json`, `CITATION.cff`, and the marketplace manifests.
- `mcp-egress-guard` blocks a call to a Youdede MCP server whose arguments name a host outside that server's declared egress, including lookalike, subdomain, userinfo, IP, and punycode forms. It binds every MCP tool in Claude Code and ships a preview Cursor adapter; `secure-agent-boundaries` 1.2.0 includes it.
- Three workflow commands (`diagnose-ci-failure`, `preflight-change-environment`, `audit-repository-instructions`) and four contexts (API, migration, CI, and dependency baselines).
- Preview MCP profiles for the official GitHub server (`v1.12.2`, read-only reduced toolset) and Playwright MCP (`0.0.82`, isolated, loopback only), in the new `remote-review-evidence` and `browser-verification` packs.
- One shared command parser and capability matcher for every Bash hook (`scripts/lib/shared-hook/shell-items.mjs`, `capability.mjs`, `inline.mjs`). Each hook declares what it protects as a `CAPABILITY` and sees through wrappers (`sudo`, `env`, `xargs`, `find -exec`, `eval`, `sh -c`), substitutions, here-documents, Git aliases, globs, brace words, and interpreter one-liners such as `python3 -c "os.system('npm publish')"`. A command it cannot read blocks only when it could touch what the hook protects.
- `quality/hook-verdicts.json` records the verdict of all 64 Claude Code hooks on about 2,500 inputs: hook tests, audit probes, command sequences, and everyday developer commands. `npm test` fails on a verdict change without a declared reason, and on a verdict that contradicts a reviewed expectation unless it is quarantined with a follow-up.

### Changed

- `npm run check:readiness` no longer requires model-judged semantic evidence to publish. Model replies vary between runs (about one case in eight changed outcome between two near-identical full runs), so a single run cannot fairly pass or fail a release. Semantic evaluation stays as an advisory maintainer test, run after prompt or case changes, and the committed receipt `quality/release-evidence/` is removed.
- Links between artifacts have three levels: required prerequisites (the installer asks once, default yes), suggestions (one hint line after an install), and related artifacts (catalog only). Each link has a short reason that the installer prints. `catalog/artifacts.json` and `catalog/packs.json` move to schema version 2 and keep every version 1 field; [docs/catalog-format.md](docs/catalog-format.md) describes the format.
- Every Bash hook names `shell-command-guard` as a prerequisite, so a command that hides what it runs (`bash -c "$X"`, `curl … | sh`) is stopped even when only one hook was requested. `add` installs it first (`--no-prerequisites` opts out), `remove` refuses it while another hook needs it unless `--force`, and five packs now include it.
- `shell-command-guard` owns every program a command runs without containing it: network output run by a shell is `internet-to-shell`, and any other unknown program is uninspectable. Shell setup output (`eval "$(pyenv init -)"`), local scripts, and static feeds pass. The other hooks leave such programs to it, which removes many false positives.
- The hooks that read what a commit will take inspect `git add … && git commit`, `git commit -am`, pathspec commits, and Git aliases instead of refusing or ignoring them. A commit in the same command as `git add -f` or an alias definition is refused: run them as separate commands.
- Behavioral cases are written for each artifact: a concrete request with its evidence, a near miss that belongs to a neighbouring artifact, a missing input, and a boundary that crosses one of the artifact's refusals. Every skill, subagent, command, and context is covered.
- GitHub Copilot skill adapters and Gemini CLI subagent adapters are `stable`, following the vendors' documentation (read 2026-09-26). Gemini CLI adapters state that Google stopped serving Gemini CLI on 2026-06-18 for free use and for Google AI Pro and Ultra.
- The Cursor adapters of the three read-only MCP servers are back to `preview` until the egress guard is verified in a live Cursor client.
- The npm package no longer contains the marketplace copies or the README images: about 1.4 MB instead of 4.8 MB, with identical CLI behavior.
- `resume-session-work` is published only for Claude Code, the only runtime where its session ledger installs.
- The summaries of `mobile-release-readiness`, `browser-verification`, `session-continuity`, and `plan-and-verify-loop` state what their members actually check.
- File-editing hooks take the project root from `CLAUDE_PROJECT_DIR` when it is set, so a `cd` into a subdirectory no longer hides or wrongly blocks an edit.

### Fixed

- The situation rules shared by every prompt artifact no longer contradict themselves. A request outside the artifact's purpose declines and names what fits instead, partial or informal material is worked from with its gaps recorded, and only an absent required input stops the work. A refused embedded instruction is recorded on its own line instead of being reported as a finding.
- Full static reviews found and resolved contradictions or gaps in dozens of prompt artifacts: finding thresholds that excluded defects the same brief defines, steps a supported branch cannot follow, unsafe completion rules, and output instructions that disagreed with the output contract. Every prompt artifact, commands included, now states one checkable output contract, and `check:contracts` rejects a missing one or one that names an instruction section.
- 139 behavioral cases now contain the code, logs, plan, or data they refer to, so a reply can be judged on the evidence.
- Generated contexts state forbidding rules as prohibitions and summary rules as "When the task calls for it", and they install where Cursor and GitHub Copilot read them (`.cursor/rules/`, `.github/instructions/`) instead of doubled paths.
- `commit-guard` and `prompt-secret-guard` share one list of 117 credential formats with the repository scan. Before, they had 7 rules and let GitHub fine-grained tokens, npm, GitLab, and Google API keys, and PGP private keys through. `commit-guard` also refuses credential stores (`.git-credentials`, `.netrc`, cloud CLI credentials) and inspects content staged by the same command, aliases, `git commit -nm`, and `core.hooksPath` overrides.
- `protected-branch-guard` refuses `git filter-branch`, `git filter-repo`, and `git fast-import`; follows branch switches inside one command; resolves a bare `git push` through `@{push}`; and fails closed when Git cannot be read. Before, an alias, a push mapping, or a timeout could move `main`.
- `shell-command-guard` blocks `/bin/rm -rf /`, a root among several `rm` operands, a force push after Git global options or with `-f` next to `--force-with-lease`, `bash <(curl …)`, a download that the same command then runs, and `git checkout -f`. It no longer blocks text quoted inside an argument.
- The six operation guards recognize many more publish, delete, apply, and service commands (cloud storage, Kubernetes, Terraform, Pulumi, registries, cron, launchd, systemd), npm abbreviations such as `npm publ`, package runners such as `npx npm@10 publish`, and value-taking global options. Several hooks no longer stall on `sudo --` until the runtime timeout, which let the command run.
- `release-clean-state-guard` and `release-version-consistency-guard` gate mobile store uploads (fastlane, `eas submit`, `xcrun altool`, Gradle `publish*`) and check Xcode, Gradle, and Expo version sources. `npm publish --access public` and `npm run build && npm publish` no longer block.
- The system path, user account, firewall, container privilege, and archive extraction guards recognize many more mutating commands and name the rule they apply instead of "cannot be normalized".
- `sensitive-file-access-guard` blocks recursive searches, archives, and copies that include a protected file, and more reading tools; `outbound-data-guard` reads grouped `curl` options. Unquoted globs are expanded as bash does instead of blocking, so `wc -l src/*.js` passes.
- `database-query-mode-guard` treats `SELECT … INTO` as a write and reads every client call; `migration-safety-guard` covers more drop and reset forms and no longer blocks the `TRUNCATE(x, d)` function; `schema-compatibility-guard` handles reserved Protobuf fields, Avro defaults, and `integer` to `number` widening.
- `ci-reference-pinning-guard` and `submodule-target-guard` check the absolute paths Claude Code sends; before, they never fired there. Several hooks now run when invoked through a symlink instead of exiting without checking. `mcp-capability-drift-guard` refuses unknown servers and tools in any letter case, recognizes plugin-scoped tools, and uses Cursor's real MCP event.
- Smaller hook fixes: `transport-security-regression-guard`, `unsafe-deserialization-guard`, `test-integrity-guard`, `debug-artifact-guard`, `lint-suppression-guard`, `api-contract-compatibility-guard`, `policy-file-guard`, `binary-mutation-guard`, `generated-file-guard`, `phase-gate-guard`, `tool-output-budget-guard`, `completion-evidence-guard`, `instruction-config-integrity-guard`, and a `prompt-secret-guard` false positive on `sk-` words. The Italian and Dutch texts of four hooks no longer change the meaning of the English source.
- A Codex project-scope hook resolves its script from the Git root instead of the installing machine's absolute path, which pointed nowhere in a clone.
- The read-only MCP runtime no longer runs programs chosen by repository configuration (`core.fsmonitor`, `gpg.program`, filter drivers), refuses credential files at any depth, and negotiates the protocol version instead of echoing it.
- Installer: `add --json` and `add-pack --json` print JSON, options accept `--name=value`, `--dry-run` lists the notice file, a failed pack install or removal restores everything it touched, and the state lock refuses symbolic links.
- Commands: `draft-evidenced-plan` runs right after `add-pack plan-and-verify-loop`, `re-pin-mcp-tools` reads the current pins, `audit-release-evidence` reports `ready` only when every check passed and prints its report, and three commands declare the `Bash` tool their precondition step needs.
- Skill helpers: the SQL, CI workflow, supply chain, schema evolution, setup wizard, work graph, skill validator, and release notes helpers miss fewer cases and reject fewer valid inputs, and six skills run their scripts from `<skill-root>` so they work from the project directory.
- Domain facts now follow their sources: the CAN-SPAM postal address requirement, the WCAG large-text threshold (14pt bold), localization text growth, and where a European standard's citation is checked.
- Catalog entries match their installed artifacts (capabilities, languages, product names, and runtimes), and `rag-evaluation-reviewer` no longer lists a tool Claude Code does not have.
- The release workflow publishes the exact commit it verified. `CITATION.cff` and documented counts are checked against the package, the package ships every module its published scripts import, and documentation claims match verified behavior.

### Removed

- `scripts/set-publisher-identity.mjs`: both decisions it applied are settled. The namespace is `youdede/toolkit`, and `Youdede` is the publisher's exact company name.
- Internal working plans (`docs/plans`), which `check:package` now refuses if they return.

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
