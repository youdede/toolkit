# Behavioral evaluations

Behavioral evaluation contracts make prompt expectations reviewable without calling a model. They are mandatory for every public skill and subagent. Each contract lives in `evaluations/behavioral.json` beside its artifact; the runner validates complete catalog coverage.

Each contract contains one realistic case for every required type:

- `positive`: a request within the artifact's job; it must declare `apply`.
- `negative`: a near miss outside that job; it must declare `decline`.
- `malformed`: missing or invalid required context; it must declare `clarify` or `decline`.
- `boundary`: a request that crosses an authority or safety boundary; it must declare `limit` or `decline`.

Every case names at least two exact `sourceAnchors` from the installed prompt, so a scenario cannot silently drift away from its artifact. Its expected contract includes required output sections, required evidence phrases, and forbidden claims and actions. A four-case baseline establishes disposition, evidence, and authority behavior for every prompt-bearing artifact. High-risk or tool-using artifacts add more task-specific cases; passing the baseline alone is not a semantic quality score.

Every subagent boundary case also places an instruction inside repository or tool evidence. This checks that logs, diffs, fixtures, manifests, and similar inputs remain inert evidence and cannot redefine the specialist's brief or authority.

The JSON format is defined by [evaluation.schema.json](../schema/evaluation.schema.json). The repository runner performs the equivalent structural and contract checks without adding a JSON Schema dependency:

```sh
node scripts/validate-evaluations.mjs
```

Use `--json` for stable machine-readable output. The runner discovers every skill and subagent from its manifest, so a newly added prompt-bearing artifact fails validation until it has a behavioral contract. Deterministic hooks and hybrid helpers are covered by declared executable event, boundary, malformed-input, false-positive, and process tests. The declarations and freshness-bound semantic release workflow are enforced by the [release-readiness gate](release-readiness.md).

## Checking saved outputs

The framework does not generate responses. To check an output produced elsewhere, save a bounded response envelope and pass it to the runner:

```json
{
  "schemaVersion": 1,
  "artifactId": "subagent/design/frontend/web-performance-reviewer",
  "responses": [
    {
      "caseId": "positive-checkout-image-regression",
      "disposition": "apply",
      "text": "## Findings\n...\n\n## Reviewed surfaces and residual uncertainty\n..."
    }
  ]
}
```

```sh
node scripts/validate-evaluations.mjs --responses ./responses.json
```

The response checker is intentionally literal and deterministic: the declared disposition must match the case contract, required sections must be Markdown headings, required evidence must appear as text, and forbidden claims/actions must not appear. It limits a response file to 1 MB and never starts a subprocess, contacts a service, or executes artifact code.

This is a contract and regression gate, not a claim that natural-language compliance has been measured semantically. A response can use an equivalent phrase the literal checker does not recognize, and a prohibited action can be paraphrased. Use these cases as fixed inputs for a separate, reviewable model or human evaluation when semantic judgment is needed; keep the saved outputs and their provenance with that evaluation rather than treating this runner as a benchmark score.
