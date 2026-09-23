# Artifact authoring

## 1. Choose the smallest useful unit

Publish one procedure, gate, specialist, command, context, or MCP profile. Do not bundle unrelated behaviors merely because they share a framework.

Choose the canonical slug from [the naming contract](naming.md): verb-first skills, `-guard` hooks, role-suffixed subagents, action/outcome commands, `-baseline` contexts, and authority-explicit MCP profiles. Slugs describe the artifact's own behavior, never its inspiration.

## 2. Place it by problem

Choose a kind, domain, and narrow category from `catalog/taxonomy.json`. Add problem, framework, language, lifecycle, and risk facets to the manifest. Use `agnostic` when the behavior genuinely applies across ecosystems.

Declare at least one controlled capability separately from granular problem tags. Record operational behavior, failure policy, latency class, and retention truthfully. Add typed relationships only when the referenced artifact has a concrete compatibility, prerequisite, conflict, replacement, or composition role.

Place a one-sentence `risk_reason` next to `risk` and a one-sentence `latency_reason` next to `operational.latencyClass`. Explain the artifact's own permitted actions, inputs, and limits, citing its payload or executable path during review. Do not grade a read-only reviewer by the severity of the defect it studies. Use `low` for bounded advice or ordinary reversible local work, `medium` for automatic blocking, sensitive decisions or data, external read access, and control-surface edits, and `high` for production access, live publication, shared-history mutation, persistent scheduled action, or external processes with unresolved privileged authority.

Use `immediate` for one synchronous bounded event check or static context load, `bounded` for multi-step work, subprocesses, repository scans, or network responses, and `background` only for autonomous asynchronous work. The class describes the operation, not an unmeasured millisecond target. If an external runtime's authority is not proven, keep the classification provisional and document the evidence gap rather than inventing certainty.

A missing test or unverified external boundary is an evidence gap, not a `risk_reason`. The reason must name the observed or declared capability that creates the risk; record what remains unproven separately in the audit.

When a user outcome needs multiple artifact kinds, add a pack instead of broadening a single artifact. Every required pack member must install on a common target, and the role must match the member kind.

## 3. State refusals

Write at least three concrete refusals in `artifact.json` and repeat operationally important boundaries in the payload. Good refusals say what the artifact will not mutate, infer, transmit, approve, or claim.

## 4. Add adapters

Keep target files under `targets/<target>/` when the payload is target-specific. Agent Skills may keep the cross-runtime `SKILL.md` at the artifact root. Adapter destinations are relative to the target component root and must not contain `..`. A package-root runtime bridge is allowed only when it is public, bounded, target-tested, and explicitly declared with `root: "package"`.

Do not publish a target adapter merely because a runtime accepts a similarly named file. Preserve the event boundary, tool authority, input shape, output semantics, failure policy, and removal contract. Put unavoidable preview status or semantic limits in the adapter's `stability` and `limitations`; withhold the adapter when the limitation would contradict the artifact's core promise.

## 5. Validate behavior

Add fixtures for deterministic hooks. Test allow, block, malformed, oversized, ambiguous, false-positive, process-exit, and boundary inputs. File gates include traversal and symlink cases; shell gates include quoting, wrappers, static nested shells, and dynamic-control arguments. For skills, subagents, commands, and contexts, add a four-case behavioral contract and ensure the trigger is narrow, scope is explicit, and completion claims require evidence. Commands also need executable precondition tests; MCP servers need trust-contract and capability-drift tests.

Run:

```bash
npm run catalog
npm run integrity
npm run check
```

## 6. Prefer deterministic components selectively

Classify every artifact as `prompt`, `hybrid`, or `deterministic`. Read [the deterministic component contract](deterministic-components.md) before adding code. Stable parsing, normalization, state collection, and validation are strong candidates; product judgment and ambiguous review remain prompt-driven.

Every declared entrypoint must be bundled by every adapter so installation remains one command. Add behavior tests before changing a skill from `prompt` to `hybrid`.
