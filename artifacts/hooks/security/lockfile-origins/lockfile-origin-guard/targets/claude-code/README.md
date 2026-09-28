# Lockfile origin guard for Claude Code

This hook examines lockfile metadata only when a Git commit is attempted. It reads the command through the shared shell item parser and commit-content analysis, so wrappers (`sudo`, `time`, `env`, `eval`, `sh -c`) are read. Configured Git aliases are followed one level (read with `git config --get-regexp` only for a subcommand that is not built in). A commit in the same command as `git add -f`, an alias definition (`git config alias.<name>`, `git -c alias.<name>=…`), a shell alias (`!…`), or an alias of an alias is refused as `lockfile-origin-inspection-incomplete`: run them as separate tool calls. A program the command runs but does not contain (`bash -c "$X"`, `curl … | sh`) is left to shell-command-guard. It inspects the staged lockfiles and, when the commit takes working-tree content (`-a`, a pathspec, or `git add` earlier in the same command), the changed or untracked lockfiles on disk. It reports stable rule identifiers without echoing origin URLs or integrity material.

HTTPS package origins with integrity metadata, lockfiles the commit does not take, and unrelated Git commands remain allowed. A commit after `cd` or with `git -C`/`--git-dir`/`--work-tree` is refused as uninspectable.

The first scanner covers npm package-lock JSON. Unsupported lockfile formats are ignored rather than treated as validated.

## Refusals

- It does not regenerate, normalize, sign, install, or verify the full dependency graph.
- It does not send package origins, credentials, integrity values, or repository content anywhere.
- It does not claim that an accepted lockfile is reproducible, authentic, or vulnerability-free.
- It does not allow command flags or repository files to disable a detected origin violation.
- It reads the lockfiles the commit takes before the Bash command runs, not after. Another command earlier in the same command line is not executed by the hook, so its effect is not seen: `npm install left-pad && git commit -am deps` rewrites the lockfile after the check. Run the change and the commit as separate tool calls so the commit is checked against the changed state.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add lockfile-origin-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives (hook-design 4.3), each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
