# Symlink publication guard for Claude Code

This hook protects the repository boundary at publication time. Before a Git commit, it inspects staged mode 120000 entries and evaluates only their stored target text.

Relative symlink targets that normalize inside the repository and unrelated Git commands remain allowed.

Hard links, generated archives, package registries, and links introduced after the check are outside this hook.

## Refusals

- It does not create, rewrite, resolve, follow, approve, or remove a symbolic link.
- It does not claim that a contained symbolic-link target exists or is safe to consume.
- It does not inspect unstaged links or links produced outside the intercepted Git commit path.
- It does not expose a repository-controlled exception list or command-line bypass.
