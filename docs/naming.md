# Artifact naming

Names are contracts for people, search, and installers. The canonical identity is:

```text
<kind>/<domain>/<category>/<slug>
```

The directory must use the plural kind and the same remaining segments:

```text
artifacts/<skills|hooks|subagents|commands|contexts|mcp-servers>/<domain>/<category>/<slug>/
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

## Commands: action plus bounded outcome

Use an imperative verb and the evidence-bearing workflow outcome, such as `diagnose-ci-failure` or `audit-repository-instructions`. A command name must match its native invocation exactly.

## Contexts: scope plus baseline

Use a narrow decision surface followed by `-baseline`, such as `api-contract-baseline`. Precedence expresses composition order; the slug does not encode the numeric precedence.

## MCP servers: authority plus mode

Name the bounded resource and the operative trust property, such as `workspace-files-readonly`. Do not use `safe`, `secure`, or `official` as a substitute for explicit egress, secret, and tool contracts.
