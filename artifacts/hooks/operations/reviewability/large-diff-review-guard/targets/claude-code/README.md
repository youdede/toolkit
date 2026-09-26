# Large diff review guard for Claude Code

This hook treats reviewability as a bounded measurable property. It checks file, line, and binary-byte totals only when a Git commit is attempted. The shared commit-content analysis tells what the commit will take: a commit of the index is measured on the staged snapshot; a commit that also takes working-tree content (`git add` or `git rm` earlier in the same command, `-a`, pathspecs, `--include`, `--only`) is measured on an upper bound, the tracked changes against HEAD plus, after `git add`, the untracked files that are not ignored. A command that stages in other ways before the commit (`git stash`, `merge`, `pull`, `reset`, `checkout` of another branch, `git add -f`), a commit after `cd` or with `git -C`, or a shell form the analysis cannot follow is refused as uninspectable. `git switch -c`/`git checkout -b` without a start point keep the index and are allowed.

The fixed limits are 50 files, 1,200 changed text lines, 5 MiB for one binary, and 20 MiB across staged binaries.

Rename similarity and semantic complexity are not estimated. The hook does not accept repository configuration or command flags as a bypass.

## Refusals

- It does not split, edit, stage, unstage, commit, summarize, review, or approve the change.
- It does not claim that a small diff is correct or that a large diff is necessarily unsafe.
- It does not count unstaged work that the commit will not take, or generated impact outside the commit.
- It does not accept repository configuration, commit flags, or prompt text as a bypass.
