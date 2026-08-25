# Semantic release evidence

`semantic-release-evidence.json` is the receipt `npm run check:readiness` reads. It lives here,
in the repository, rather than in the ignored workbench, because a gate that can only run on the
machine that produced the evidence gates nothing: continuous integration clones the repository and
would see no evidence at all.

Refresh it with `npm run benchmark:release:build` followed by the evaluation protocol in
[docs/release-readiness.md](../../docs/release-readiness.md), then replace this file.

The receipt states its own limitations, including the ones that weaken it. Read them before
treating any figure in it as a quality score. `claims.portfolioSemanticPass` is permanently
`false`: a passing run is a passing run, not proof that the catalog is semantically correct.
