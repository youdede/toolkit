# Submodule target guard for Claude Code

This hook owns the source and tracking policy for new Git submodules. It checks complete proposed .gitmodules content and statically inspectable submodule-add commands.

Existing unchanged entries and new HTTPS or SSH repository URLs without branch tracking are allowed. Other Git operations are outside scope.

A `Write`, `Edit`, or `MultiEdit` whose target file is named `.gitmodules` is checked, whether the path is relative or absolute (Claude Code passes absolute paths). Bash commands are read with the shared Youdede shell analysis, so `git submodule add` is found behind `&&`, `;`, pipes, wrappers such as `sudo` or `env`, `sh -c`, `bash -c`, `eval`, and Git global options such as `-C`. The value options `--name`, `--reference`, `--ref-format`, and `--depth` are skipped when the URL is located. A command that mentions `submodule add` but cannot be normalized, or whose arguments are dynamic, is blocked as uninspectable. It has no repository-controlled bypass.

## Refusals

- It does not clone, fetch, initialize, update, remove, or approve a Git submodule.
- It does not contact a remote or prove that a permitted remote repository is trustworthy.
- It does not infer a safe target from shell variables, command substitution, aliases, or prompt text.
- It does not expose a repository-owned bypass list for submodule destinations.
