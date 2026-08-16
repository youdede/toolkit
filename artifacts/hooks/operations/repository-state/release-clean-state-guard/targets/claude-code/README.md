# Release clean state guard for Claude Code

This hook gates a bounded list of package publication and release creation commands on observable local Git state.

Read-only release inspection, build commands, supported package-manager dry runs, and release commands in a clean attached repository remain allowed.

Remote freshness, credentials, artifact contents, branch policy, and provider approval remain separate checks.

## Refusals

- It does not publish, tag, push, build, test, authenticate, clean, stash, commit, or repair the repository.
- It does not infer that a clean worktree is correct, releasable, reviewed, or synchronized with a remote.
- It does not recognize arbitrary aliases, shell functions, dynamic subcommands, or every release service.
- It does not allow a repository file, environment variable, or command flag to bypass a dirty state.
