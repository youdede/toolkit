# Pack format

A pack composes independently installable artifacts into one workflow. Its manifest follows
[`pack.schema.json`](../schema/pack.schema.json). Existing manifests need no new fields.

## Entry and workflow

`entry` optionally names the artifact ID of a required member with role `entrypoint` or
`procedure`. An entrypoint can be a command or a skill. A skill entrypoint also satisfies the
required procedure rule. `entry` identifies the starting instruction; installation does not run it.

`workflow` is an optional non-empty ordered array of steps. Each step has a `member` artifact ID
and a lowercase hyphenated `phase`. An optional `signal` describes when the step applies in
1-240 characters. Steps can repeat a member, including returning to the entry skill to report.
The array supplies the order; phase names do not imply sorting or scheduling. Every reference
must name a declared logical member, even when that member has a target-specific replacement.
Signals are instructions for the runtime agent to assess, not executable predicates. Without a
signal, the step is unconditional. A workflow can omit passive members such as hooks.

Illustrative fields, not a published pack:

```json
{
  "entry": "skill/example/review/collect-review",
  "workflow": [
    {"member": "skill/example/review/collect-review", "phase": "inventory"},
    {"member": "subagent/example/review/review-verifier", "phase": "verify", "signal": "Review material is available"},
    {"member": "skill/example/review/collect-review", "phase": "report"}
  ]
}
```

## Target members

A member retains its required `artifactId`, `role`, and `required` fields. Optional `targets` maps
known runtime names to artifact IDs. Optional `fallback` names the artifact used when the target
has no map entry. Selection is `targets[target]`, then `fallback`, then `artifactId`.
An explicit target selection is authoritative: an unsupported adapter or scope does not trigger
another fallback. Optional members are skipped only for unsupported targets or scopes;
other installation errors still fail the transaction.

```json
{
  "artifactId": "subagent/example/review/review-verifier",
  "role": "verifier",
  "required": true,
  "targets": {"claude-code": "subagent/example/review/review-verifier"},
  "fallback": "skill/example/review/verify-review"
}
```

The base ID is the stable logical member identity used by `entry`, `workflow`, and outcome
mappings. Every alternative must exist and support the same role. Two members must not resolve
to the same artifact. The target's selected required artifacts must have a common scope and
meet the existing composition, prerequisite, conflict, and hook fan-out rules. A required skill
verifier satisfies the assurance rule; two distinct skills for procedure and verification are
allowed without adding a subagent or an otherwise unnecessary artifact kind. This declares
verification responsibility and does not prove that the runtime provides independent execution.

Planning and installation return the same resolved `entry` and `workflow` fields, and the selected
artifacts in their member plans. Installation order remains member declaration order; workflow
order describes subsequent use. See [installation](install.md) and the
[audit workflow decision](decisions/0003-declare-portable-pack-workflows.md).

## Publication and evidence

The catalog publishes declared fields unchanged and omits fields absent from the manifest. No
empty `entry`, `workflow`, `targets`, or `fallback` fields are added to existing packs. Compatibility
is calculated from selected artifacts for each target. No catalog generator change is needed.

Outcome mappings retain logical member IDs. The existing evidence verifier remains structural;
this extension does not translate execution receipts from alternatives or add evidence states.
Workflow signals do not authorize skipping evidence required by the existing report schema.
