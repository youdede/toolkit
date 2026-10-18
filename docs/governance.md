# Repository governance

This repository treats operational quality as a chain of inspectable controls. No single badge, review, model judgment, or test run proves that the software is correct. The goal is to make changes attributable, reviewable, reproducible, and reversible.

## Change path

```text
short-lived branch
  -> conventional commits and PR title
  -> local deterministic hooks
  -> pull request with evidence
  -> SHA-pinned CI on Linux
  -> required quality-gate
  -> squash merge into signed linear main
  -> manually authorized, versioned, provenance-backed release
```

`main` is the only long-lived branch. Direct pushes, force pushes, merge commits, and branch deletion are blocked after the initial repository bootstrap; the ruleset's single bypass actor, the repository admin role, can act only through a pull request, never by direct push. Pull requests require resolved review threads and a successful `quality-gate`. While there is one maintainer, the repository does not claim an independent approval: the required approval count is zero and the PR itself remains the durable review record.

## Controls and evidence

| Boundary | Control | Durable evidence |
| --- | --- | --- |
| Local commit | Versioned `commit-msg` hook | Conventional header or a stable rejection code |
| Local push | Versioned `pre-push` hook | Complete `npm run check` result |
| Pull request | Template plus policy job | Scope, risks, tests, release impact, commit and branch validation |
| Cross-platform behavior | Pinned GitHub Actions matrix | Linux (ubuntu-latest) check runs on Node 20, 22, and 24; macOS and Windows are not run in CI |
| Protected history | GitHub ruleset | PR-only, required status, signatures, linear history, no force push/delete |
| Artifact integrity | Deterministic public manifest | `catalog/integrity.json` root digest |
| Release authorization | Manual dispatch, exact package-and-tag confirmation, signed tag, and environment controls available on the active plan | Workflow record and npm OIDC provenance |

Local hooks improve feedback but are not an authority boundary because Git permits `--no-verify`. The server-side CI and branch rules remain authoritative. CI actions are pinned to immutable commit SHAs; Dependabot proposes reviewed updates rather than moving those references silently.

## Branch and merge policy

Branch names use a controlled prefix documented in [`CONTRIBUTING.md`](../CONTRIBUTING.md). Pull request titles follow the same Conventional Commit grammar as commits. The repository allows squash merge only so the reviewed PR title becomes the canonical `main` subject and the public history remains one cohesive commit per change.

Release tags use `vMAJOR.MINOR.PATCH`, must identify the exact package version, and are signed. A tag push never starts publication; the release workflow requires a separate manual dispatch and exact confirmation. Published npm versions are immutable: npm never accepts the same version number twice. Tags are not moved or deleted by policy; no tag ruleset enforces this today. A failed release is corrected with a new version, not by rewriting an existing tag or package.

## Temporary private phase

The private repository is `youdede/toolkit`. It was `udede/toolkit` until 2026-10-18, when the maintainer renamed the GitHub account into the controlled `youdede` namespace and updated every namespace reference together; the [publishing checklist](publishing-checklist.md) lists the files. GitHub redirects the old name only while nobody claims the `udede` username, so new references use `youdede/toolkit`.

The repository must remain private until the full reachable history, Actions logs, issue content, and release metadata have been reviewed for publication. Making a private repository public exposes its complete reachable commit history.

GitHub Pro does not provide required environment reviewers for this private user-owned repository,
and npm does not generate provenance from a private source repository. The release workflow records
the environment but does not claim an independent reviewer; it fails closed while the repository is
private. The [publishing checklist](publishing-checklist.md) records how those controls change when a
supported public or enterprise configuration is deliberately chosen.

## Exceptions

An exception must name the failing control, explain why the control is not applicable, bound the affected change, and be recorded in the pull request. Exceptions do not authorize hiding failures, weakening a threshold, rewriting published history, or claiming evidence that was not observed.
