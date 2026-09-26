# CI trust boundary guard for Claude Code

The hook runs before Write, Edit, or MultiEdit on recognized root CI files for GitHub Actions, GitLab CI, CircleCI, Buildkite, and Azure Pipelines. It reconstructs the complete proposed file within a 512 KiB bound and compares normalized findings with the existing file. MultiEdit edits are applied in order; a MultiEdit is refused when its complete result cannot be reconstructed. An unchanged legacy finding does not freeze an otherwise safe edit; only a net-new high-confidence trust expansion is blocked.

The bounded policy covers:

- GitHub Actions `permissions: write-all` and selected high-authority `write` scopes;
- broad reusable-workflow secret inheritance;
- contributor-controlled checkout (head refs of the pull request or workflow run, or `refs/pull/<n>/head`) combined with an untrusted trigger (`pull_request_target`, `workflow_run`, or `issue_comment`) and secret or write-token authority;
- Azure checkout credential persistence;
- GitLab secret trace logging;
- explicit privileged executors and Docker or Podman host-socket mounts in any recognized provider file.

The scanner strips YAML comments, treats block scalar structure conservatively, and never executes or submits workflow content. Missing, ambiguous, oversized, out-of-root, or symlinked relevant edits are blocked because the complete trust change cannot be verified. The installed hook has no runtime allowlist, inline suppression, environment bypass, or project-authored approval file.

## Refusals and limits

- The hook does not execute, validate, format, rewrite, approve, or trigger a CI workflow.
- It does not claim complete YAML interpretation or complete coverage of any provider's security model.
- It does not treat a tag, branch, comment, prompt statement, or environment variable as approval.
- It does not reveal secret expressions, commands, credentials, or inspected content in block messages.
- It does not replace provider permissions, protected environments, branch protection, pinned dependencies, or human review.
