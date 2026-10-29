# Dependency change guard for Claude Code

The hook protects three narrow boundaries:

1. Write/Edit cannot directly modify a recognized lockfile; use the owning package manager so the result is regenerated.
2. Bash cannot use selected flags that explicitly bypass lockfile generation, dependency resolution, platform requirements, or secure package transport.
3. Before `git commit`, a changed dependency manifest is paired with the nearest existing compatible lockfile. When dependency-relevant content changed, that lockfile must also be committed. When the commit takes working-tree content (`-a`, a pathspec, or `git add` earlier in the same command), changed working-tree manifests are compared too, and a lockfile changed in the working tree counts as committed. Lockfile edits are recognized by file name even outside the current directory.

Commit consistency supports `package.json`, `composer.json`, `Cargo.toml`, `pyproject.toml`, `Gemfile`, and `go.mod`. JSON manifests are structurally compared. Python manifests use bounded dependency-section fingerprints. Cargo supports ordinary, development, build, target-specific, and `[workspace.dependencies]` forms by conservatively requiring the nearest existing `Cargo.lock` for any staged `Cargo.toml` change. This is a consistency check, not a vulnerability audit or complete package-manager model.

The commit check requires the Git command to run in the hook's active worktree. Commands that first use `cd`/`pushd`, `git -C`, `--git-dir`, `--work-tree`, or a `GIT_DIR`/`GIT_WORK_TREE` assignment are blocked as an unverifiable scope; run the hook from the intended worktree instead. Configured Git aliases are followed one level (read with `git config --get-regexp` only for a subcommand that is not built in). A commit in the same command as `git add -f`, an alias definition (`git config alias.<name>`, `git -c alias.<name>=…`), a shell alias (`!…`), or an alias of an alias is refused as `dependency-commit-scope-unsupported`: run them as separate tool calls.

Commands are read with the shared shell item parser: a package-manager command whose bypass flag, lockfile value, index URL, or registry setting is known only at run time is uninspectable, and a program the command runs but does not contain (`bash -c "$X"`, `curl … | sh`) is left to shell-command-guard.

The installed hook deliberately has no project-writable allowlist, command digest approval, environment bypass, or inline suppression. Because the same agent can invoke Bash, those mechanisms cannot authenticate human review. Exceptional work must be performed by a person outside the guarded agent session or after that person explicitly disables the exact hook entry.

## Refusals and limits

- The hook does not run a package manager, regenerate a lockfile, select a version, or rewrite a manifest.
- It does not claim that paired diffs are valid, secure, installable, or equivalent across platforms.
- It does not model every workspace layout or package manager; exceptional layouts must be handled by a human outside the guarded session.
- It does not echo a blocked install command or transmit repository content.
- It does not expose a project file or command-controlled mechanism that lets the agent author its own bypass.
- It reads the manifests and lockfiles the commit takes before the Bash command runs, not after. Another command earlier in the same command line is not executed by the hook, so its effect is not seen: `npm install left-pad && git commit -am deps` changes the manifest and lockfile after the check. Run the change and the commit as separate tool calls so the commit is checked against the changed state.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add dependency-change-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives, each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
