# Executable permission guard for Claude Code

This hook detects executable permission additions in what a Git commit will take: the staged index and, when the commit takes working-tree content (`-a`, a pathspec, or `git add` earlier in the same command), the executable bit and first bytes of changed or untracked files on disk (the bit only when `core.fileMode` is on). Commands are read through the shared shell item parser and commit-content analysis, so quoted text and wrappers are read. Configured Git aliases are followed one level (read with `git config --get-regexp` only for a subcommand that is not built in). A commit in the same command as `git add -f`, an alias definition (`git config alias.<name>`, `git -c alias.<name>=…`), a shell alias (`!…`), or an alias of an alias is refused as `executable-permission-inspection-incomplete`: run them as separate tool calls. A program the command runs but does not contain (`bash -c "$X"`, `curl … | sh`) is left to shell-command-guard. Declarative files are rejected directly; text scripts need a recognized interpreter shebang.

Existing executable files, ordinary non-executable changes, and supported script files with recognized shebangs remain allowed.

The hook evaluates the Git mode and a bounded prefix of each file the commit takes. It does not run or semantically review executable content.

## Refusals

- It does not chmod, rewrite, stage, unstage, execute, sign, or approve a file.
- It does not claim that a recognized shebang makes a program safe or portable.
- It does not inspect filesystem permissions of files the commit does not take.
- It does not provide a repository-authored extension or path bypass.
- It reads the modes the commit takes before the Bash command runs, not after. Another command earlier in the same command line is not executed by the hook, so its effect is not seen: `chmod +x metadata.json && git commit -am x` sets the executable bit after the check. Run the change and the commit as separate tool calls so the commit is checked against the changed state.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add executable-permission-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives, each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
