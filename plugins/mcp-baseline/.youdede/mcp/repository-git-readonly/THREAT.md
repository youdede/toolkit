# Repository Git Readonly — threat note

The server invokes only `git status`, `git diff`, and `git log` with fixed read-only arguments,
strips inherited `GIT_*` routing variables, never contacts a remote, and caps process output. Commit
messages and diffs remain untrusted model input. The profile does not claim that read-only access is
non-sensitive or that local Git configuration cannot affect every possible Git implementation.
