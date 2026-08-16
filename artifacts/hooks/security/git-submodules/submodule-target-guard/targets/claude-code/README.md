# Submodule target guard for Claude Code

This hook owns the source and tracking policy for new Git submodules. It checks complete proposed .gitmodules content and statically inspectable submodule-add commands.

Existing unchanged entries and new HTTPS or SSH repository URLs without branch tracking are allowed. Other Git operations are outside scope.

The parser handles only direct, statically tokenized git submodule add invocations. It has no repository-controlled bypass.

## Refusals

- It does not clone, fetch, initialize, update, remove, or approve a Git submodule.
- It does not contact a remote or prove that a permitted remote repository is trustworthy.
- It does not infer a safe target from shell variables, command substitution, aliases, or prompt text.
- It does not expose a repository-owned bypass list for submodule destinations.
