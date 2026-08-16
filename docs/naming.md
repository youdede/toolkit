# Artifact naming

Names are contracts for people, search, and installers. The canonical identity is:

```text
<kind>/<domain>/<category>/<slug>
```

The directory must use the plural kind and the same remaining segments:

```text
artifacts/<skills|hooks|subagents>/<domain>/<category>/<slug>/
```

All segments use lowercase ASCII hyphen-case. Slugs are unique across the full catalog, contain at most 64 characters, and do not include version numbers. A vendor name belongs in the slug only when that integration is the capability itself.

## Skills: verb first

Use `<verb>-<object-or-outcome>`. The name should describe what the agent does after loading the procedure.

- `conduct-source-backed-research`
- `provision-postgres-readonly-role`
- `write-session-handoff`

Avoid menu labels, vague nouns, and claims such as `ultimate` or `best`.

## Hooks: boundary plus guard

Use `<protected-boundary>-guard`. The name should make the interception point or protected resource obvious.

- `commit-guard`
- `policy-file-guard`
- `shell-command-guard`

## Subagents: scope plus role

Use `<narrow-scope>-<role>`. Approved role suffixes describe responsibility rather than personality: `reviewer` evaluates a bounded change, `auditor` checks evidence against an explicit policy, `analyst` explains relationships or causes, `diagnostician` ranks hypotheses and discriminating checks, `mapper` records traceable relationships without approval, `verifier` tests a precise claim, `planner` sequences a bounded outcome, `researcher` gathers evidence, `specialist` applies a narrow domain brief, and `tester` exercises a defined interface.

- `dependency-risk-reviewer`
- `test-gap-reviewer`
