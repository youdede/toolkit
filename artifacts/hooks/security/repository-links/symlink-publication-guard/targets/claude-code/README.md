# Symlink publication guard for Claude Code

This hook protects the repository boundary at publication time. Before a Git commit, it inspects staged mode 120000 entries and evaluates only their stored target text.

Bash commands are read with the shared Youdede shell item parser and commit-content analysis, so a commit is found behind `&&`, `;`, pipes, `sudo`, `time`, `env`, `eval`, `sh -c`, `bash -c`, `xargs`, and `find -exec`. Configured Git aliases are followed one level (read with `git config --get-regexp` only for a subcommand that is not built in). A commit in the same command as `git add -f`, an alias definition (`git config alias.<name>`, `git -c alias.<name>=…`), a shell alias (`!…`), or an alias of an alias is refused as `symlink-publication-inspection-incomplete`: run them as separate tool calls. A program the command runs but does not contain (`bash -c "$X"`, `curl … | sh`) is left to shell-command-guard. Text quoted inside an argument, such as `git commit -m 'fix; later'`, is not a command separator.

When the commit can take working-tree content (`-a`, `--include`, `--only`, a pathspec, or a `git add` earlier in the same command), the hook also reads the targets of the symbolic links in the working tree among tracked and untracked files. A commit run after `cd` or with `-C`, `--git-dir`, or `--work-tree`, or a command whose commit the analysis cannot read, is blocked as not inspectable.

Relative symlink targets that normalize inside the repository and unrelated Git commands remain allowed.

Hard links, generated archives, package registries, and links introduced after the check are outside this hook.

## Refusals

- It does not create, rewrite, resolve, follow, approve, or remove a symbolic link.
- It does not claim that a contained symbolic-link target exists or is safe to consume.
- It does not inspect unstaged links or links produced outside the intercepted Git commit path.
- It does not expose a repository-controlled exception list or command-line bypass.
- It reads the links the commit takes before the Bash command runs, not after. Another command earlier in the same command line is not executed by the hook, so its effect is not seen: `ln -sf /etc/passwd a.sh && git commit -am x` replaces the file with an escaping link after the check. Run the change and the commit as separate tool calls so the commit is checked against the changed state.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add symlink-publication-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives (hook-design 4.3), each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
