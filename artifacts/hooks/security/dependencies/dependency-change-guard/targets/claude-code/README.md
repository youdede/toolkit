# Dependency change guard for Claude Code

The hook protects three narrow boundaries:

1. Write/Edit cannot directly modify a recognized lockfile; use the owning package manager so the result is regenerated.
2. Bash cannot use selected flags that explicitly bypass lockfile generation, dependency resolution, platform requirements, or secure package transport.
3. Before `git commit`, a changed dependency manifest is paired with the nearest existing compatible lockfile. When dependency-relevant content changed, that lockfile must also be committed. When the commit takes working-tree content (`-a`, a pathspec, or `git add` earlier in the same command), changed working-tree manifests are compared too, and a lockfile changed in the working tree counts as committed. Lockfile edits are recognized by file name even outside the current directory.

Commit consistency supports `package.json`, `composer.json`, `Cargo.toml`, `pyproject.toml`, `Gemfile`, and `go.mod`. JSON manifests are structurally compared. Python manifests use bounded dependency-section fingerprints. Cargo supports ordinary, development, build, target-specific, and `[workspace.dependencies]` forms by conservatively requiring the nearest existing `Cargo.lock` for any staged `Cargo.toml` change. This is a consistency check, not a vulnerability audit or complete package-manager model.

The commit check requires the Git command to run in the hook's active worktree. Commands that first use `cd`/`pushd`, `git -C`, `--git-dir`, or `--work-tree` are blocked as an unverifiable scope; run the hook from the intended worktree instead.

The installed hook deliberately has no project-writable allowlist, command digest approval, environment bypass, or inline suppression. Because the same agent can invoke Bash, those mechanisms cannot authenticate human review. Exceptional work must be performed by a person outside the guarded agent session or after that person explicitly disables the exact hook entry.

## Refusals and limits

- The hook does not run a package manager, regenerate a lockfile, select a version, or rewrite a manifest.
- It does not claim that paired diffs are valid, secure, installable, or equivalent across platforms.
- It does not model every workspace layout or package manager; exceptional layouts must be handled by a human outside the guarded session.
- It does not echo a blocked install command or transmit repository content.
- It does not expose a project file or command-controlled mechanism that lets the agent author its own bypass.
- It reads the manifests and lockfiles the commit takes before the Bash command runs, not after. Another command earlier in the same command line is not executed by the hook, so its effect is not seen: `npm install left-pad && git commit -am deps` changes the manifest and lockfile after the check. Run the change and the commit as separate tool calls so the commit is checked against the changed state.
