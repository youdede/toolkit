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

## Output contract consistency

Each prompt payload states one output contract: the headings a reply must carry, in order. That declaration is only useful when it agrees with the rest of the payload, so a separate fail-closed check compares them:

```sh
npm run check:contracts
```

It fails when the output-contract section is missing or duplicated, when a heading is demanded outside the contract but not named in it, when numbered, bulleted, or prose ordering disagrees, when an explicit first/last instruction disagrees, when an exceptional path says to omit required sections, when an instruction points at an undeclared findings section, when a heading is declared twice, or when a behavioral case requires a section the contract omits. A mention that states its own fallback for an undeclared heading is conditional and is not a contradiction. The check refuses to report success if it reads no payload at all. These are the contradiction forms the deterministic checker models; broader semantic consistency remains part of signed review evidence.

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

The response checker is deterministic: the same response text always produces the same verdict. It fails a response when any output-contract heading is missing or out of order, when a case-required section is missing, or when a forbidden claim or action appears in a modeled assertion framing. It limits a response file to 1 MB and never starts a subprocess, contacts a service, or executes artifact code.

Two fields are deliberately not graded, and the reason matters when reading a result.

`disposition` is not part of a response. It used to be self-reported by the responder and compared for equality, which is not decidable from the text: a response can honestly belong to two dispositions at once, for example refusing an instruction embedded in the evidence while also lacking the inputs to proceed. Required sections already differ per disposition, so section presence records which path was taken without asking the responder to label itself.

`requiredEvidence` is reported as advice rather than enforced. Measured over a 176-case sample, requiring each phrase as a literal substring agreed with an independent judge on 44 percent of cases, because an idea such as "cannot proceed" has unbounded surface forms and a correct response states it in its own words. The deterministic checker enforces every declared output heading in order and checks forbidden phrases in explicit assertion, refusal, quotation, question, conditional, attribution, uncertainty, and handoff framings. The phrases stay in each contract as reviewer guidance, and the checker lists the ones it did not find verbatim so a reviewer can confirm the idea is present.

This is a contract and regression gate, not a general natural-language theorem prover. It recognizes a bounded set of explicit framings and common edit paraphrases; other paraphrases still require the separately signed model or human evaluation. Use the cases as fixed inputs for that review and keep the saved outputs and their provenance rather than treating the literal checker as a semantic benchmark score.
