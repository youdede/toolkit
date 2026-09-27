# Contributing

Contributions are welcome when they are narrow, reusable, licensed, reviewable, and testable. Repository controls exist to preserve evidence, not to imply that a passing check proves correctness.

## Set up the repository

Use Node.js 20 or newer. Install the dependency lockfile exactly, then enable the versioned Git hooks:

```sh
npm ci
npm run setup:repo
npm run check
```

The setup command configures only this checkout. It points Git at `.githooks/`, which enables `commit-msg` (commit policy) and `pre-push` (runs `npm run check`), sets pulls to fast-forward only, and prunes deleted remote branches on fetch.

## Branches and commits

Work on a short-lived branch. Use one of these prefixes followed by a lowercase description whose words are separated by hyphens, dots, underscores, or slashes:

```text
feat/        fix/         docs/       refactor/
test/        ci/          chore/      security/
release/     codex/       agent/
```

The policy also accepts `dependabot/` and `renovate/` for automated dependency branches.

Commit headers follow Conventional Commits and are at most 72 characters (the ` (#123)` suffix a GitHub squash merge appends is not counted only for commits that Git confirms are reachable from `origin/main`, when a manual run validates that history; without `origin/main` every header is measured whole):

```text
type(optional-scope): lowercase imperative summary
```

Allowed types are `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, and `security`. Examples:

```text
feat(cli): verify installed artifact integrity
fix(installer): reject an ancestor symlink
docs(governance): explain release evidence
```

Use `!` and a `BREAKING CHANGE:` footer for incompatible changes. Do not use `WIP`, `fixup!`, or `squash!` commits in a pull request. Git allows `--no-verify`, but CI applies the same policy and a bypass must never be used to conceal a failing control.

## Artifact changes

1. Read `docs/authoring.md`, `docs/naming.md`, and `docs/governance.md`.
2. Add one original, narrow artifact or one cohesive repository change.
3. Add fixtures or tests proportional to its risk.
4. Regenerate catalogs and integrity metadata when the artifact surface changes.
5. Review README when public behavior, installation, runtime coverage, counts, or evidence claims change. Update it when affected; otherwise note why it needs no change in the pull request. A README edit is not required for every change.
6. Run `npm run check`.
7. Explain the problem, refusal boundary, risk, validation evidence, and release impact in the pull request.

Do not submit scraped prompt dumps, artifacts with unknown licenses, obfuscated scripts, telemetry, credential collection, silent network calls, or code that weakens host permissions.

## Pull requests

- Use a Conventional Commit title; squash merge uses that title as the canonical `main` commit.
- Keep one reviewable concern per pull request.
- Resolve every review conversation and keep the branch current with `main`.
- Include exact validation commands and distinguish observed evidence from inference.
- Add an architecture decision record under `docs/decisions/` when a durable tradeoff changes.

`main` accepts pull requests only, uses squash merging, requires signed commits, linear history, resolved review threads, and the `quality-gate` status check, and rejects force pushes and deletions. Approval count is intentionally zero while the project has a single maintainer; self-review is not represented as independent review.
