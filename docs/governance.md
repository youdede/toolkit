# Repository governance

This repository treats operational quality as a chain of inspectable controls. No single badge, review, model judgment, or test run proves that the software is correct. The goal is to make changes attributable, reviewable, reproducible, and reversible.

## Change path

```text
short-lived branch
  -> conventional commits and PR title
  -> local deterministic hooks
  -> pull request with evidence
  -> pinned CI across supported platforms
  -> required quality-gate
  -> squash merge into signed linear main
  -> versioned, provenance-backed release
```

`main` is the only long-lived branch. Direct pushes, force pushes, merge commits, and branch deletion are blocked after the initial repository bootstrap; the ruleset's single bypass actor, the repository admin role, can act only through a pull request, never by direct push. Pull requests require resolved review threads and a successful `quality-gate`. While there is one maintainer, the repository does not claim an independent approval: the required approval count is zero and the PR itself remains the durable review record.

## Controls and evidence

| Boundary | Control | Durable evidence |
| --- | --- | --- |
| Local commit | Versioned `commit-msg` hook | Conventional header or a stable rejection code |
| Local push | Versioned `pre-push` hook | Complete `npm run check` result |
| Pull request | Template plus policy job | Scope, risks, tests, release impact, commit and branch validation |
| Cross-platform behavior | Pinned GitHub Actions matrix | Linux, macOS, and Windows check runs on supported Node versions |
| Protected history | GitHub ruleset | PR-only, required status, signatures, linear history, no force push/delete |
| Artifact integrity | Deterministic public manifest | `catalog/integrity.json` root digest |
| Release authorization | Protected environment and human approval | Signed tag, release record, npm OIDC provenance |

Local hooks improve feedback but are not an authority boundary because Git permits `--no-verify`. The server-side CI and branch rules remain authoritative. CI actions are pinned to immutable commit SHAs; Dependabot proposes reviewed updates rather than moving those references silently.

## Branch and merge policy

Branch names use a controlled prefix documented in [`CONTRIBUTING.md`](../CONTRIBUTING.md). Pull request titles follow the same Conventional Commit grammar as commits. The repository allows squash merge only so the reviewed PR title becomes the canonical `main` subject and the public history remains one cohesive commit per change.

Release tags use `vMAJOR.MINOR.PATCH`, must identify the exact package version, and are signed. Tags and published npm versions are immutable. A failed release is corrected with a new version, not by rewriting an existing tag or package.

## Temporary private phase

The current private repository is `udede/toolkit`. Before a public release or npm trusted-publisher setup, the maintainer will either rename the GitHub account or transfer the repository to the controlled `youdede` namespace, then update every namespace reference together; the [publishing checklist](publishing-checklist.md) lists the exact files.

The repository must remain private until the full reachable history, Actions logs, issue content, and release metadata have been reviewed for publication. Making a private repository public exposes its complete reachable commit history.

## Exceptions

An exception must name the failing control, explain why the control is not applicable, bound the affected change, and be recorded in the pull request. Exceptions do not authorize hiding failures, weakening a threshold, rewriting published history, or claiming evidence that was not observed.
