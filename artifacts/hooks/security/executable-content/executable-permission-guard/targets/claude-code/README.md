# Executable permission guard for Claude Code

This hook detects executable permission additions in what a Git commit will take: the staged index and, when the commit takes working-tree content (`-a`, a pathspec, or `git add` earlier in the same command), the executable bit and first bytes of changed or untracked files on disk (the bit only when `core.fileMode` is on). Commands are read through the shared shell and commit-content analysis, so quoted text, wrappers, and Git aliases are resolved. Declarative files are rejected directly; text scripts need a recognized interpreter shebang.

Existing executable files, ordinary non-executable changes, and supported script files with recognized shebangs remain allowed.

The hook evaluates the Git mode and a bounded prefix of each file the commit takes. It does not run or semantically review executable content.

## Refusals

- It does not chmod, rewrite, stage, unstage, execute, sign, or approve a file.
- It does not claim that a recognized shebang makes a program safe or portable.
- It does not inspect filesystem permissions of files the commit does not take.
- It does not provide a repository-authored extension or path bypass.
