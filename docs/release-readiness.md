# Release readiness

Release readiness has two independent evidence layers. Structural quality can pass while the package remains not publishable:

1. Structural evidence validates every artifact manifest and payload contract, every skill, subagent, command, and context behavioral contract, all required positive, negative, malformed, and boundary cases, and every executable hook or hybrid-helper test declaration.
2. Semantic evidence reviews every prompt-bearing artifact statically and evaluates a deterministic stratified sample of behavioral cases. It expires after 30 days and becomes invalid immediately when the benchmark input digest changes.

Run the independently useful structural gate with:

```sh
npm run check:quality
```

Run the aggregate publishability gate with:

```sh
npm run check:readiness
```

Use `node scripts/validate-release-readiness.mjs --json` for machine-readable results. A failed result contains stable reason codes, current and reported scope, benchmark freshness, sample coverage, and the refresh paths. A structurally valid package is not automatically semantically ready.

## Executable test declarations

[`quality/script-tests.json`](../quality/script-tests.json) maps every hook and hybrid skill entrypoint to executable tests. Hook declarations require allow, deny-or-observe, malformed, oversized, boundary, false-positive, and process-exit evidence. Hybrid helpers require positive, negative, malformed, and boundary evidence. Each case maps to an exact source anchor in a declared test file, and each test source must anchor the executable filename or artifact ID.

Adding an executable artifact, deleting a declared test, removing a case anchor, or pointing a declaration outside `tests/*.test.mjs` fails the structural gate. Declarations prove that reviewed tests exist; the normal `npm test` run proves that they currently execute successfully.

## Refreshing semantic evidence

Build fresh blind inputs from the current installed prompts and behavioral contracts:

```sh
npm run benchmark:release:build
```

The builder writes ignored working data beneath `.youdede-workbench/release-benchmark/`. It records the fixed seed `youdede-release-semantic-v1`, the SHA-256 benchmark digest, the complete static-review population, every dynamic candidate, the sampled population, per-dimension coverage, and every populated stratum.

The benchmark is model-agnostic:

1. Review every record in `static-inputs.json` against a documented rubric. Do not sample the static population.
2. Send every record in `dynamic-inputs.json` to the selected runner without exposing `secret-expectations.json`.
3. Have an independent judge assess disposition, required outcome, evidence honesty, and safety boundaries. Calibrate both static review and judging on separately reviewed examples.
4. Write `quality/release-evidence/semantic-release-evidence.json` using [`semantic-release-evidence.schema.json`](../schema/semantic-release-evidence.schema.json), recording the runner, independent judge, model identifiers, one static result per prompt artifact, and one dynamic judgment per sampled benchmark ID. The gate reads this committed file first and falls back to `.youdede-workbench/reports/semantic-release-evidence.json` only when the committed file is absent.
5. Run `npm run check:readiness` and preserve its JSON output with the release review.

The dynamic sample is stratified by kind, domain, risk, and case type. It selects at least one case from every populated cross-stratum, then fills strata round-robin until it reaches the larger of 128 cases or 20% of candidates. The fixed seed makes selection reproducible.

To evaluate every candidate case instead of the sample, build with:

```sh
npm run benchmark:release:build -- --full
```

The benchmark records the effective selection policy, and the gate rebuilds using that recorded policy rather than assuming the default. A recorded policy that would select fewer cases than the release minimum is refused with `SEMANTIC_BENCHMARK_POLICY_WEAKENED`, so the flag can raise coverage but never lower it. Complete coverage removes sampling error; it does not remove run-to-run variation, and a single passing run of every case is still not proof that the portfolio is semantically correct.

The report must state `portfolioSemanticPass: false` either way: neither a passing sample nor one passing run at complete coverage is converted into “100% of the portfolio is semantically proven.”

Every case is written for its artifact and embeds the synthetic evidence it needs: the files, diffs, logs, or figures that support the expected finding. The cases test disposition, procedure, evidence labeling, output shape, and authority boundaries; they do not claim to measure the correctness of a domain-specific conclusion. A case that asks for an evidence-backed conclusion while withholding the evidence is a fixture defect, not a model failure.

After a prompt or fixture change, a result may be carried into the next receipt only when the complete runner input and secret expectation are byte-identical and the prior independent judgment passed. Every changed input must be run and judged again. The receipt limitations must disclose any such reuse; the benchmark digest still binds the complete current population.

Readiness requires all of the following without lowering thresholds:

- Every prompt-bearing artifact has a static result, every result passes, no artifact scores below 70, the aggregate is at least 80, and no confirmed defect remains.
- Every sampled dynamic case passes all four criteria and no contract fixture issue remains.
- Static within-one-point calibration and judge criterion agreement are each at least 95%.
- The evidence is at most 30 days old, is not future-dated, and matches the current benchmark digest exactly.
- The evidence records an independent judge, model provenance, substantive limitations, and no exhaustive portfolio semantic-pass claim.

The gate does not sign evidence or prove that a declared external evaluator actually ran. Preserve raw runner and judge outputs in the ignored workbench or an access-controlled review system, and use independent review for release authorization.

## Blocking publisher decisions

Structural and semantic readiness do not resolve publisher identity. The [publishing checklist](publishing-checklist.md) records what each of these steps needs and in which order; [`.github/workflows/release.yml`](../.github/workflows/release.yml) implements the parts that can be automated and refuses to publish until both gates pass.

Before the first public release, the accountable publisher must:

1. Confirm the exact legal person or entity that owns or administers the `Youdede` copyright notice. Do not substitute an invented company name.
2. Verify the namespace migration from `udede/toolkit` to `youdede/toolkit` (account renamed 2026-10-18, references updated together): the badge renders and the issue links resolve while signed out once the repository is public.
3. Manually dispatch the fail-closed release workflow for a signed tag, using npm trusted publishing or another provenance-capable OIDC flow. Add an environment reviewer when the repository visibility and GitHub plan support it; never claim that approval while the control is unavailable.
4. Publish the `catalog/integrity.json` root digest through the authenticated release page and verify it against the packed npm artifact.
5. Confirm npm scope ownership, required two-factor authentication, and release approval authority.

A local checksum manifest is not a substitute for these publisher controls.
