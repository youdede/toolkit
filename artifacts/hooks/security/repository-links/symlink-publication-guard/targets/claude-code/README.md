# Symlink publication guard for Claude Code

This hook protects the repository boundary at publication time. Before a Git commit, it inspects staged mode 120000 entries and evaluates only their stored target text.

Bash commands are read with the shared Youdede shell and commit-content analysis, so a commit is found behind `&&`, `;`, pipes, `sudo`, `time`, `env`, `eval`, `sh -c`, `bash -c`, `xargs`, `find -exec`, and Git aliases (configured, defined earlier in the same command, or passed with `git -c alias.<name>=`). Text quoted inside an argument, such as `git commit -m 'fix; later'`, is not a command separator.

When the commit can take working-tree content (`-a`, `--include`, `--only`, a pathspec, or a `git add` earlier in the same command), the hook also reads the targets of the symbolic links in the working tree among tracked and untracked files, and among ignored files when `git add -f` runs in the command. A commit run after `cd` or with `-C`, `--git-dir`, or `--work-tree`, or a command that mentions Git but cannot be normalized, is blocked as not inspectable.

Relative symlink targets that normalize inside the repository and unrelated Git commands remain allowed.

Hard links, generated archives, package registries, and links introduced after the check are outside this hook.

## Refusals

- It does not create, rewrite, resolve, follow, approve, or remove a symbolic link.
- It does not claim that a contained symbolic-link target exists or is safe to consume.
- It does not inspect unstaged links or links produced outside the intercepted Git commit path.
- It does not expose a repository-controlled exception list or command-line bypass.
