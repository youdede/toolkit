# Repository Git Readonly — threat note

The server invokes only `git status`, `git diff`, and `git log` with fixed read-only arguments,
strips inherited `GIT_*` routing variables, never contacts a remote, and caps process output. Commit
messages and diffs remain untrusted model input. The profile does not claim that read-only access is
non-sensitive or that local Git configuration cannot affect every possible Git implementation.

Credential files recognised by `sensitive-file-access-guard` are excluded from `git_diff`.

Every call passes `--no-optional-locks`, `-c core.fsmonitor=false`, and
`-c diff.autoRefreshIndex=false`, so repository configuration cannot start an fsmonitor program and
status or diff never rewrite `.git/index`; `git_log` passes `--no-show-signature`, so
`log.showSignature` cannot start `gpg.program`. Residual risk: a filter driver named in
`.gitattributes` with a `filter.<name>.clean` or `process` command in the repository configuration
still runs during `git_status` and `git_diff`. It is not disabled because Git LFS relies on the same
mechanism to report LFS files correctly.
