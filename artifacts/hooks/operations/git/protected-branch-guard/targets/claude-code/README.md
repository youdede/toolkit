# Protected branch guard for Claude Code

This project-scoped `PreToolUse` hook protects `main`, `master`, and the locally discoverable repository-default branch. It uses bounded, non-shell Git subprocesses to identify the repository, current branch, and `refs/remotes/origin/HEAD`. It blocks native `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` calls while the current branch is protected.

For Bash calls, the hook performs bounded lexical parsing without executing expansions. It recognizes literal wrapper layers, static shell `-c` payloads, protected-branch history mutations, protected local-ref deletion, protected remote-ref deletion, and direct pushes whose destination is protected. A malformed or dynamically constructed relevant command fails closed. Detached HEAD and verified non-repository directories do not block native edits; an unborn protected branch does.

## Refusals and limits

- The hook does not create a feature branch, stash work, checkpoint, commit, merge, rebase, delete, or push.
- It has no project-writable bypass and does not treat a command comment or environment variable as approval.
- It does not call a network service, inspect remote branch-protection settings, or claim to replace server-side rules.
- It does not interpret Git aliases or arbitrary scripts as hidden Git operations; dynamic executable selection and relevant scope changes are refused instead.
- It does not cover filesystem mutations performed by arbitrary Bash commands, MCP tools, IDE extensions, or other processes.

Examples it refuses include a native edit on `main`, `git commit` on the default branch, `git branch -D main`, `git update-ref -d refs/heads/main`, `git push origin feature:main`, and a static wrapped equivalent. It allows read-only Git commands, a direct push to an unprotected feature branch, branch switching, recovery-only `--abort`/`--quit` operations, and `git push --dry-run`.
