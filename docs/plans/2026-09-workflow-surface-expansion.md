# Development plan: workflow surface and artifact kind expansion

- Date: 2026-09-21
- Status: In progress — phases 0–5b complete; phase 6 implementation complete, release authorization pending
- ADR: [0002](../decisions/0002-extend-artifact-kinds-for-agent-workflows.md)

## Motivation

The catalog expresses three artifact kinds — skills, hooks, and subagents — across six runtime
targets, each with refusals, evidence requirements, and deterministic validation. Three surfaces
are not yet expressible:

1. **User-invoked workflows**: multi-step procedures the user triggers explicitly, with declared
   tool authority and required evidence output.
2. **Always-on and scoped context**: rule files that shape every model decision while installed,
   with scope, precedence, and expiry.
3. **External tool-server configurations**: MCP servers whose trust boundary, network egress, and
   secret access must be declared and verified before use.

In addition, session continuity (checkpoint and resume across conversations) is implementable with
the existing hook and skill kinds and does not require a new kind.

Every phase follows the repository change path (branch → conventional commits → PR → quality-gate →
squash merge) and the authoring contract: refusals, narrow triggers, six-target adapters or declared
limitations, and fixture tests for anything deterministic.

## Phase 0 — Foundations

**Exit criteria:** `command`, `context`, and `mcp-server` are installable kinds; the full check
suite passes with zero artifacts of the new kinds present.

1. Extend `schema/artifact.schema.json` with kind-specific required fields per ADR 0002.
2. Extend `catalog/taxonomy.json` (kinds list) and `schema/taxonomy.schema.json` if needed.
3. Update `scripts/validate.mjs`, `generate-catalog.mjs`, `generate-integrity.mjs`,
   `generate-catalog-docs.mjs`, and the CLI (`bin/youdede-toolkit.mjs`) install/remove paths.
4. Update `docs/targets.md` with the kind × runtime support matrix; withheld adapters documented.
5. Tests: schema validation per kind, install/remove round-trip per target, withheld-adapter
   behavior, catalog and integrity regeneration, doc-stat counts.
6. CHANGELOG entry; minor version bump prepared.

## Phase 1 — Commands: evidence-contract workflows

**Exit criteria:** users can invoke workflow commands whose mandatory first action verifies
preconditions deterministically and whose completion requires declared evidence.

A command is an **evidence contract with an invocation**. The manifest declares:

- `produces`: evidence artifacts the command must emit to count as complete.
- `requires`: preconditions checked deterministically as Step 0; a command whose preconditions
  fail must stop and name the missing precondition. Native slash-command runtimes load the prompt
  before this bridge runs, so the repository does not claim a pre-invocation parser.
- `flags`: constraint-narrowing only (`--scope=`, `--budget=`); a flag may shrink what a command
  may do, never expand its authority. Unknown combinations fail validation.

Initial command set (each with `toolAuthority` allowlist and refusals):

| Command | Purpose | Refuses (examples) |
| --- | --- | --- |
| `draft-evidenced-plan` | Produce an ordered plan with code anchors and emit a plan evidence artifact | Does not edit code; refuses invocation without an installed standards context |
| `verify-claims-against-output` | Run declared checks and emit a verification report with output hashes | Does not approve a change; does not rerun with undeclared flags |
| `assemble-review-brief` | Emit diff scope, risk notes, and test evidence as a review brief | Does not approve or merge |
| `audit-release-evidence` | Run the release-readiness evidence suite and emit a signed report | Does not publish, tag, or bypass any guard |

Preconditions are evaluated by one shared deterministic runtime bridge
(`scripts/runtime/command-precondition.mjs`, following the `hook-command-bridge.mjs` pattern):
bounded checks for clean tree, required files, installed contexts, and valid prior evidence.
Commands declare preconditions as data and ship only a thin wrapper around the shared evaluator.
The runtime/model must honor Step 0 before continuing the workflow.

Tests: invocation parsing, precondition refusal fixtures, flag-combination validation,
authority-boundary fixtures (command attempts tool outside allowlist → refused), refusal presence,
adapter generation per target.

### 1b. Gated phase chains

The `plan-and-verify-loop` pack implements a phased delivery model — `spec → design → tasks →
implementation` — with a `phase-gate-guard` hook that refuses phase advancement until the previous
phase's evidence artifact exists and validates against schema. `draft-evidenced-plan` requires an
installed standards context or refuses to plan.

## Phase 2 — Session continuity, deterministic

**Exit criteria:** the `session-continuity` pack installs checkpoint hooks and a resume skill;
state is redacted, bounded, tamper-evident, and removable; no model judgment in the persist path.

1. `hook/operations/session/session-checkpoint-guard` — on session end, appends structured state
   (goal, touched files, pending claims, decision refs) to an **append-only, hash-chained ledger**:
   each checkpoint embeds the previous entry's digest plus a git anchor (HEAD + dirty-set hash).
   Storage location, retention, and redaction are declared in the manifest; redaction reuses the
   secret-scanning machinery tested in `tests/secret-scan.test.mjs`. Retroactive edits break the
   chain, while an independently stored head seal detects tail truncation. This is local integrity,
   not authorship: an actor able to rewrite both ledger and seal is explicitly outside the threat model.
2. `hook/operations/session/session-restore-guard` — on session start, injects a bounded summary;
   oversized or malformed state is rejected, never truncated silently.
3. `hook/operations/session/compact-readiness-guard` — warns before compaction when uncommitted
   changes or unverified completion claims exist.
4. `skill/operations/session/resume-session-work` — reconstructs context from the ledger under a
   declared byte budget; summarization is explicitly lossy and at read time, the ledger is never
   rewritten, and every carried-forward claim must cite its ledger entry hash. Required "could not
   verify" section.
5. `command/operations/session/verify-session-ledger` — verifies chain integrity and git anchors;
   proves what happened between two commits.
6. `command/operations/session/record-work-checkpoint` — user-invoked checkpoint append into the
   ledger; refuses secrets, tokens, or file contents outside the declared schema.
7. `hook/development/resource-management/tool-output-budget-guard` — deterministic per-tool byte
   quotas with bounded retry guidance. Claude Code's post-tool hook cannot safely replace the
   original result, so the guard observes and warns without echoing or silently truncating output;
   adapters are withheld where an equivalent observation contract is unavailable.
7. Tests: ledger chain integrity and tamper detection, retention expiry, redaction of planted
   secrets, malformed/oversized state, symlink and traversal on the state path,
   concurrent-session collision, git-anchor correctness on detached HEAD and dirty trees, budget
   truncation boundaries.

The ledger and its verification command ship in the same phase, and pack evidence reports (Phase 5)
consume it immediately, so the chain is exercised from its first release.

## Phase 3 — Contexts

**Completed 2026-09-21.** The four baselines are generated from catalog fields into native,
project-scoped Claude Code, Cursor, and GitHub Copilot rule files. Rule contracts name an action,
effect, source field, and source artifact; hooks may declare blocked actions, allowing the installer
to reject a contradictory co-installation with the exact rule and hook named. Context generation is
CI-checked, expiry emits a non-blocking install warning, and unsupported aggregate-only targets are
withheld rather than written through unsafe shared-file merges.

**Exit criteria:** users can install scoped, non-conflicting rule files; the validator rejects
context/hook contradictions; stale contexts warn on install.

1. Initial contexts: `coding-style-baseline`, `git-workflow-baseline`, `security-baseline`,
   `testing-baseline` — each scoped, each with precedence and refusal statements. Rules carry
   **provenance links** to the catalog artifact IDs they descend from and are regenerated from
   catalog data, never hand-maintained prose. Contexts support `expires`: a stale context warns on
   install.
2. Conflict detection in `validate.mjs`: a context instructing behavior blocked by a co-installed
   hook fails validation with a named rule.
3. Tests: glob scoping, precedence ordering, conflict fixtures, removal cleanliness, expiry
   warnings.

## Phase 4 — MCP server configs with declared trust

**Completed 2026-09-21.** Three project-scoped local stdio servers provide bounded workspace-file,
local-Git, and allowlisted-document reads for Claude Code and Cursor. Their native config entries
are merged and removed reversibly; exact tool-description hashes, profiles, egress, secret access,
launch commands, threat notes, and generated runtime copies are CI-verified. A fail-closed guard
rejects unknown toolkit server/tool identities and description or inventory drift when exposed by
the client. Re-pinning requires a deterministic proposal digest, exact human confirmation, full
verification, and an evidence receipt.

**Exit criteria:** `mcp-server` artifacts ship with egress, secret-access, and pinned-tool
declarations; `secure-agent-boundaries` pack includes an MCP guard before any config is marked
stable.

1. `scripts/verify-mcp.mjs` — validates manifest egress/secret declarations against the referenced
   server configuration, plus static scanning for undeclared egress and tool-poisoning patterns,
   baked into the validator rather than a separate tool.
2. **Pinned tool manifests**: each `mcp-server` artifact records the vetted tool list (names +
   description hashes); the egress guard blocks on **capability drift** — a server that silently
   adds tools after vetting is quarantined until re-vetted.
3. Egress guard hook for MCP-bearing runtimes.
4. Initial curated set: read-only, low-egress servers (filesystem-scoped, git, fetch-with-allowlist)
   — each with a threat note; nothing with write-to-network by default.
5. `command/development/agent-tooling/re-pin-mcp-tools` — sanctioned re-vetting path: re-observes a
   server's tool list, diffs it against the pin, requires human confirmation of the diff, and
   records the re-vet as ledger evidence. A boundary that cannot absorb legitimate change gets
   bypassed; this keeps the boundary livable without weakening it.
6. Tests: undeclared egress detected, secret-access violations detected, manifest/config drift
   detected, tool-list drift detected.

## Phase 5 — Pack improvement and expansion

**Exit criteria:** ≥10 packs; existing packs gain command entrypoints and evidence contracts.

**Completed 2026-09-21.** The catalog now has eleven packs. All carry semantic versions,
outcome-to-member evidence mappings, ledger-linked report contracts, and four checked behavioral
scenarios. The four planned workflow packs and the three planned upgrades are present, and every
new composition passes common-target install/remove coverage.

1. New packs: `plan-and-verify-loop`, `session-continuity`, `daily-driver` (meta),
   `mcp-baseline`.
2. Upgrade `release-readiness`: add `audit-release-evidence` command + machine-readable evidence
   report member.
3. Upgrade `reviewable-change`: add `assemble-review-brief` command + diff-scope guard.
4. Upgrade `secure-agent-boundaries`: add MCP egress guard + trust-boundary skill.
5. Pack-level tests: member installability on a common target per pack, role/kind match, evidence
   report schema validation.
6. Pack hardening (see [pack improvement analysis](#pack-improvement-analysis) below): versioned
   evidence reports, explicit `outcomes` ↔ member-evidence mapping, and pack-level behavioral
   evaluations.

## Phase 5b — Native marketplace distribution

**Exit criteria:** the catalog is installable from native plugin marketplaces, not only via npm.

**Completed 2026-09-21.** Generated Claude Code and Codex manifests now package only semantics each
runtime preserves. Claude Code publishes ten complete pack plugins; the context-dependent
`plan-and-verify-loop` is recorded as omitted. Codex publishes all 166 supported skills and records
the five withheld kinds. Both native validators pass, and CI checks every generated byte.

Extend `generate-catalog.mjs` to emit native manifests at build time (`.claude-plugin/marketplace.json`,
`.codex-plugin/plugin.json`, and equivalents per target). Marketplace copy is generated **from
schema fields only** (summary, refusal counts, evidence badges) — no hand-written marketing. Pure
packaging: no new content, the catalog stays the single source of truth, manifests are generated
artifacts checked by CI.

## Phase 6 — Capability documentation

**Exit criteria:** the docs state the catalog's capability surface honestly and it stays true.

**Implemented 2026-09-21.** The capability matrix is generated from the validated catalog and
checked byte-for-byte in CI. The main behavioral-evaluation suite now covers every pack's four
ledger-linked evidence scenarios. The minor-release audit is recorded by the release-readiness
gate; tag creation and OIDC publication remain deliberately pending explicit publisher authority.

The `0.3.0` candidate passes every structural gate and the complete reachable-history secret scan.
It is not publishable yet: `check:readiness` reports `SEMANTIC_BENCHMARK_DIGEST_MISMATCH`,
`SEMANTIC_STATIC_COVERAGE_INCOMPLETE` (210 recorded of 229 required), and
`SEMANTIC_DYNAMIC_COVERAGE_INCOMPLETE` (the prior 890-case receipt does not match the current
deterministic 195-case sample). A new independently run and judged semantic receipt is required
before a signed tag or publication.

1. `docs/capability-matrix.md` mapping each artifact kind and pack to its guarantees
   (precondition-gated invocation, tamper-evident session records, drift-verified tool servers),
   CI-checked so claims cannot silently rot.
2. Evaluations: extend `tests/behavioral-evaluations.test.mjs` so each new workflow pack has a
   recorded evaluation with evidence.
3. Release-readiness run for the minor version; signed tag; OIDC provenance publication.

## Sequencing and dependencies

```text
Phase 0 (kinds)
  ├─> Phase 1 (commands) ──────┐
  ├─> Phase 2 (continuity) ────┼─> Phase 5 (packs) ─> Phase 6 (docs)
  ├─> Phase 3 (contexts) ──────┤        ▲
  └─> Phase 4 (mcp) ───────────┴────────┘ (secure-agent-boundaries upgrade needs Phase 4)
```

Phases 1–4 are parallelizable after Phase 0. Phase 5's `mcp-baseline` and the
`secure-agent-boundaries` upgrade are blocked on Phase 4. Phase 5b is independent and can ship
any time after Phase 0.

## Pack improvement analysis

Assessed whether existing packs need structural change beyond the Phase 5 upgrades. Conclusion:
**two improvements are necessary, one is not (yet).**

1. **Necessary — evidence reports as pack contracts.** Today a pack's `outcomes` are prose. Each
   pack gains a machine-readable evidence report (schema exists:
   `schema/semantic-release-evidence.schema.json` is the precedent): installing the pack means the
   user can produce a verifiable "outcome achieved" artifact. Reports are **hash-linked to the
   session ledger** (Phase 2), so a pack outcome carries a verifiable evidence chain.
2. **Necessary — pack-level behavioral evaluations.** Packs are the product surface; they need
   recorded evaluations like artifacts have, or the "composed outcome" claim is unverified.
3. **Not now — pack versioning and dependency pinning between packs.** A real need only when
   external authors publish packs against ours. Deferred until marketplace distribution
   (Phase 5b) creates third-party consumers; adding it earlier is speculative complexity against
   the authoring contract's "smallest useful unit" principle.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| New kinds dilute the governance posture | Kind-specific trust fields are mandatory in schema, not conventions |
| Runtime parity gaps look like broken installs | Withheld adapters + explicit `docs/targets.md` matrix + CLI warning naming the limitation |
| Session state becomes a secret leak path | Redaction reuses tested secret-scan machinery; planted-secret fixtures in every continuity test |
| Context files contradict hooks at runtime | Install-set validation rejects contradictions; conflict fixtures in CI |
| MCP trust surface grows faster than review capacity | No `mcp-server` artifact ships stable before its egress guard exists; curated set starts read-only |

Every new artifact additionally passes the standard private authoring gates before merge, per the
repository's established authoring process.
