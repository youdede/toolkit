# Repository Git Readonly — threat note

The server invokes only `git status`, `git diff`, and `git log` with fixed read-only arguments,
strips inherited `GIT_*` routing variables, never contacts a remote, and caps process output. Commit
messages and diffs remain untrusted model input. The profile does not claim that read-only access is
non-sensitive or that local Git configuration cannot affect every possible Git implementation.

Credential files recognised by `sensitive-file-access-guard` are excluded from `git_diff`.

Every call passes `--no-optional-locks`, `-c core.fsmonitor=false`, and
`-c diff.autoRefreshIndex=false`, so repository configuration cannot start an fsmonitor program and
status or diff never rewrite `.git/index`; `git_log` passes `--no-show-signature`, so
`log.showSignature` cannot start `gpg.program`. Before `git_status` and `git_diff`, the server reads
the effective `filter.<name>.clean`, `smudge`, and `process` settings with the same options (reading
configuration runs no program). It refuses the call, without running Git, unless every such setting
is a command written by `git lfs install` or `git lfs install --skip-smudge`: `git-lfs clean -- %f`,
`git-lfs smudge -- %f`, `git-lfs smudge --skip -- %f`, `git-lfs filter-process`, or
`git-lfs filter-process --skip`. Residual risk: those commands resolve `git-lfs` through `PATH`.
