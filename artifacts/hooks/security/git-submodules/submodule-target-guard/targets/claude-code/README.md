# Submodule target guard for Claude Code

This hook owns the source and tracking policy for new Git submodules. It checks complete proposed .gitmodules content and statically inspectable submodule-add commands.

Existing unchanged entries and new HTTPS or SSH repository URLs without branch tracking are allowed. Other Git operations are outside scope.

A `Write`, `Edit`, or `MultiEdit` whose target file is named `.gitmodules` is checked, whether the path is relative or absolute (Claude Code passes absolute paths). Bash commands are read with the shared item parser, so `git submodule add` is found behind `&&`, `;`, pipes, wrappers such as `sudo` or `env`, `sh -c`, `bash -c`, `eval`, and Git global options such as `-C`. The value options `--name`, `--reference`, `--ref-format`, and `--depth` are skipped when the URL is located. A `git submodule add` whose repository is known only at run time, or a command the parser stops at, is blocked as uninspectable. It has no repository-controlled bypass.

A program the command runs but does not contain (`bash -c "$CMD"`, `curl … | sh`, `eval "$(tool)"`, `python3 -c "$CODE"`) is judged by shell-command-guard; this hook refuses one only when its text names `submodule add`.

## Refusals

- It does not clone, fetch, initialize, update, remove, or approve a Git submodule.
- It does not contact a remote or prove that a permitted remote repository is trustworthy.
- It does not infer a safe target from shell variables, command substitution, aliases, or prompt text.
- It does not expose a repository-owned bypass list for submodule destinations.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add submodule-target-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives, each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
