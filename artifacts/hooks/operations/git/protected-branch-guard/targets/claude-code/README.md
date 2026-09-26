# Protected branch guard for Claude Code

This project-scoped `PreToolUse` hook protects `main`, `master`, and the locally discoverable repository-default branch. It uses bounded, non-shell Git subprocesses to identify the repository, current branch, and `refs/remotes/origin/HEAD`. It blocks native `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` calls while the current branch is protected.

For Bash calls, the hook performs bounded lexical parsing without executing expansions. It recognizes literal wrapper layers, static shell `-c` payloads, protected-branch history mutations, protected local-ref deletion, protected remote-ref deletion, and direct pushes whose destination is protected. A bare `git push` (or `git push <remote>` to the same remote) is resolved through Git's own `@{push}` and blocked only when that destination is protected; when Git cannot name a single destination, the push is refused. Configured Git aliases are expanded once and re-inspected. A refspec without an explicit destination is refused when its remote has a `remote.<name>.push` mapping, because the mapping can redirect it. `git send-pack` and `git http-push` are refused, and so are command runners (`xargs`, `find -exec`, `parallel`, `watch`) that start a relevant Git subcommand. A malformed or dynamically constructed relevant command fails closed. Detached HEAD and verified non-repository directories do not block native edits; an unborn protected branch does.

## Refusals and limits

- The hook does not create a feature branch, stash work, checkpoint, commit, merge, rebase, delete, or push.
- It has no project-writable bypass and does not treat a command comment or environment variable as approval.
- It does not call a network service, inspect remote branch-protection settings, or claim to replace server-side rules.
- It does not interpret arbitrary scripts as hidden Git operations; dynamic executable selection and relevant scope changes are refused instead.
- Shell aliases (`!…`) and aliases of aliases are blocked as uninspectable.
- It does not cover filesystem mutations performed by arbitrary Bash commands, MCP tools, IDE extensions, or other processes.

Examples it refuses include a native edit on `main`, `git commit` on the default branch, `git branch -D main`, `git update-ref -d refs/heads/main`, `git push origin feature:main`, and a static wrapped equivalent. It allows read-only Git commands, a direct push to an unprotected feature branch, a bare `git push` whose configured destination is unprotected, branch switching, recovery-only `--abort`/`--quit` operations, and `git push --dry-run`.
