# Pack format

A pack composes independently installable artifacts into one workflow. Its manifest follows
[`pack.schema.json`](../schema/pack.schema.json). The two fields below are optional; a manifest
without them stays valid.

## Entry and workflow

`entry` names the artifact ID of a required member with role `entrypoint` or `procedure`. It tells
a reader where to start; installation does not run it.

`workflow` is a non-empty ordered array of steps. Each step has a `member` artifact ID and a
lowercase hyphenated `phase`. An optional `signal` says when the step applies, in 1-240
characters. The array supplies the order; phase names imply no sorting or scheduling. Every step
must name a declared member. A step can repeat a member, and passive members such as hooks can be
left out. A signal is an instruction for the agent to assess, not an executable predicate; a step
without one is unconditional.

```json
{
  "entry": "command/operations/ci-cd/diagnose-ci-failure",
  "workflow": [
    {"member": "command/operations/ci-cd/diagnose-ci-failure", "phase": "diagnose"},
    {"member": "skill/operations/ci-cd/debug-ci-failure", "phase": "debug", "signal": "the diagnosis needs a reproduced failure or a fix"},
    {"member": "subagent/operations/ci-cd/ci-failure-analyst", "phase": "review", "signal": "an independent read of the failure evidence is wanted"}
  ]
}
```

## Where the fields appear

`pack-info` prints the entry and the ordered steps, and `add-pack` ends with the entry. The JSON
forms of `pack-info`, `add-pack --dry-run`, and `add-pack`, and `catalog/packs.json`, carry both
fields unchanged when the manifest declares them and omit them otherwise. Installation order stays
member declaration order; workflow order describes later use.

The installer does not execute steps, evaluate signals, or certify that a workflow was followed.
Outcome evidence keeps its existing contract. See [installation](install.md) and the
[decision record](decisions/0003-declare-pack-entry-and-workflow.md).
