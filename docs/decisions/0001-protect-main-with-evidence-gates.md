# 0001: Protect main with evidence gates

- Status: Accepted
- Date: 2026-08-17

## Context

The toolkit is both a distributable service surface and a public demonstration of engineering practice. A neat commit graph alone cannot show whether a change was tested, reviewed, attributable, or safe to release. The repository initially has one maintainer, so a nominal one-approval requirement would either deadlock changes or misrepresent self-review as independent review.

## Decision

Use short-lived branches and pull requests for every post-bootstrap change. Enforce Conventional Commit headers locally and in CI, validate branch and PR-title grammar, pin CI actions, require the aggregate `quality-gate`, resolve review conversations, allow squash merge only, require signed commits on `main`, and reject force pushes or deletion of `main`.

Set the required approval count to zero while there is only one maintainer. Record self-review evidence in the pull request without describing it as independent approval. Raise the approval count when an independent maintainer with review authority is added.

## Consequences

- The `main` history remains linear and maps one-to-one to merged change proposals.
- Local feedback is fast for commit grammar and comprehensive before push, while server controls remain authoritative.
- CI cost is higher because supported operating systems and Node versions are exercised.
- Emergency changes still require a pull request and passing evidence; administrators do not receive a silent bypass.
- The initial root commit is a one-time bootstrap exception because no protected default branch exists before the first push.
