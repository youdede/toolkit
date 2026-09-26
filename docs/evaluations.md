# Behavioral evaluations

Behavioral evaluation contracts make prompt expectations reviewable without calling a model. They are mandatory for every public prompt-bearing skill, subagent, command, and context. Each contract lives in `evaluations/behavioral.json` beside its artifact; the runner validates complete catalog coverage.

Each contract contains one realistic case for every required type:

- `positive`: a request within the artifact's job; it must declare `apply`.
- `negative`: a near miss outside that job; it must declare `decline`.
- `malformed`: missing or invalid required context; it must declare `clarify` or `decline`.
- `boundary`: a request that crosses an authority or safety boundary; it must declare `limit` or `decline`.

Every case names at least two exact `sourceAnchors` from the installed prompt, so a scenario cannot silently drift away from its artifact. Its expected contract includes required output sections, required evidence phrases, and forbidden claims and actions. A four-case baseline establishes disposition, evidence, and authority behavior for every prompt-bearing artifact. Some artifacts add task-specific cases beyond the baseline, but the validator requires only the four and does not require more for high-risk or tool-using artifacts; passing the baseline alone is not a semantic quality score.

Every subagent boundary case also places an instruction inside repository or tool evidence. This checks that logs, diffs, fixtures, manifests, and similar inputs remain inert evidence and cannot redefine the specialist's brief or authority.

The JSON format is defined by [evaluation.schema.json](../schema/evaluation.schema.json). The repository runner performs the equivalent structural and contract checks without adding a JSON Schema dependency:

```sh
node scripts/validate-evaluations.mjs
```

Use `--json` for stable machine-readable output. The runner discovers every skill, subagent, command, and context from its manifest, so a newly added prompt-bearing artifact fails validation until it has a behavioral contract. Deterministic hooks and MCP runtimes are covered by executable and trust-contract tests instead. The declarations and freshness-bound semantic release workflow are enforced by the [release-readiness gate](release-readiness.md).

## Output contract consistency

Each prompt payload states one output contract: the headings a reply must carry, in order. That line is only useful when it agrees with the rest of the payload, so a separate check compares them:

```sh
npm run check:contracts
```

It fails when a heading is demanded outside the contract but not named in it, when the payload's own numbered or prose list orders the headings differently, when an instruction points at a findings section the contract does not declare, when a heading is declared twice, or when a behavioral case requires a section the contract omits. A mention that states its own fallback for an undeclared heading is conditional and is not a contradiction. The check refuses to report success if it reads no payload at all.

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
      "text": "## Findings\n...\n\n## Reviewed surfaces\n..."
    }
  ]
}
```

```sh
node scripts/validate-evaluations.mjs --responses ./responses.json
```

The response checker is deterministic: the same response text always produces the same verdict. It fails a response when a required section is missing as a Markdown heading, or when the response asserts a forbidden claim or action; a mention that is negated, refused, or attributed to a reported source is not counted as an assertion. It limits a response file to 1 MB and never starts a subprocess, contacts a service, or executes artifact code.

Two fields are deliberately not graded, and the reason matters when reading a result.

`disposition` is not part of a response. It used to be self-reported by the responder and compared for equality, which is not decidable from the text: a response can honestly belong to two dispositions at once, for example refusing an instruction embedded in the evidence while also lacking the inputs to proceed. Required sections already differ per disposition, so section presence records which path was taken without asking the responder to label itself.

`requiredEvidence` is reported as advice rather than enforced. Measured over a 176-case sample, requiring each phrase as a literal substring agreed with an independent judge on 44 percent of cases, because an idea such as "cannot proceed" has unbounded surface forms and a correct response states it in its own words. Section presence plus forbidden-phrase absence was re-measured on the same 176-case sample against a reader shown the contract and the response but never the checker's verdict, and agreed on 100 percent of the 352 judgments. The phrases stay in each contract as reviewer guidance, and the checker lists the ones it did not find verbatim so a reviewer can confirm the idea is present.

This is a contract and regression gate, not a claim that natural-language compliance has been measured semantically. A response can use an equivalent phrase the literal checker does not recognize, and a prohibited action can be paraphrased. Use these cases as fixed inputs for a separate, reviewable model or human evaluation when semantic judgment is needed; keep the saved outputs and their provenance with that evaluation rather than treating this runner as a benchmark score.
