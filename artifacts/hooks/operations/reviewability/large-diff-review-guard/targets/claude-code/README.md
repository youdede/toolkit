# Large diff review guard for Claude Code

This hook treats reviewability as a bounded measurable property. It checks file, line, and binary-byte totals only when a Git commit is attempted. The shared commit-content analysis tells what the commit will take: a commit of the index is measured on the staged snapshot; a commit that also takes working-tree content (`git add` or `git rm` earlier in the same command, `-a`, pathspecs, `--include`, `--only`) is measured on an upper bound, the tracked changes against HEAD plus, after `git add`, the untracked files that are not ignored. A command that stages in other ways before the commit (`git stash`, `merge`, `pull`, `reset`, `checkout` of another branch), a commit after `cd` or with `git -C`, or a shell form the analysis cannot follow is refused as uninspectable. Configured Git aliases are followed one level (read with `git config --get-regexp` only for a subcommand that is not built in). A commit in the same command as `git add -f`, an alias definition (`git config alias.<name>`, `git -c alias.<name>=…`), a shell alias (`!…`), or an alias of an alias is refused as `large-diff-inspection-incomplete`: run them as separate tool calls. A program the command runs but does not contain (`bash -c "$X"`, `curl … | sh`) is left to shell-command-guard. `git switch -c`/`git checkout -b` without a start point keep the index and are allowed.

The fixed limits are 50 files, 1,200 changed text lines, 5 MiB for one binary, and 20 MiB across staged binaries.

Rename similarity and semantic complexity are not estimated. The hook does not accept repository configuration or command flags as a bypass.

## Refusals

- It does not split, edit, stage, unstage, commit, summarize, review, or approve the change.
- It does not claim that a small diff is correct or that a large diff is necessarily unsafe.
- It does not count unstaged work that the commit will not take, or generated impact outside the commit.
- It does not accept repository configuration, commit flags, or prompt text as a bypass.
- It reads the diff the commit takes before the Bash command runs, not after. Another command earlier in the same command line is not executed by the hook, so its effect is not seen: `node generate.js > data.json && git commit -am x` produces the large file after the check. Run the change and the commit as separate tool calls so the commit is checked against the changed state.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add large-diff-review-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives, each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
- An option the hook has not verified, before a safe option (`git commit --unknown --dry-run`), is read both ways, so the safe mode does not count; verifying the option into the CLI fixture fixes it.
