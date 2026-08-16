# worktree-removal-evidence-guard

Install with `npx @youdede/toolkit add worktree-removal-evidence-guard`. Before Claude Code removes a worktree, this observer runs `git status --porcelain=v1 --untracked-files=all` with a five-second timeout and a one-MiB output cap. It reports only the number of changed entries.

Claude Code does not let `WorktreeRemove` hooks block removal, so this artifact deliberately fails open and makes no prevention claim. It does not install a `WorktreeCreate` hook because doing so would replace Claude Code's default Git worktree implementation.

## Refusals and limits

- It does not create, retain, delete, clean, commit, stash, or modify worktree state.
- It does not claim to prevent removal or recover removed files.
- It does not print changed paths, diff content, branch names, or repository remotes.
- It does not follow symlink worktree paths or execute repository-provided commands.
