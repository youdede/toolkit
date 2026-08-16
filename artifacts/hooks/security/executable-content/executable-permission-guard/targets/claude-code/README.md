# Executable permission guard for Claude Code

This hook detects executable permission additions in the staged Git index. Declarative files are rejected directly; text scripts need a recognized interpreter shebang.

Existing executable files, ordinary non-executable changes, and supported script files with recognized shebangs remain allowed.

The hook evaluates Git mode and a bounded staged prefix. It does not run or semantically review executable content.

## Refusals

- It does not chmod, rewrite, stage, unstage, execute, sign, or approve a file.
- It does not claim that a recognized shebang makes a program safe or portable.
- It does not inspect filesystem permissions that are not represented in the staged Git index.
- It does not provide a repository-authored extension or path bypass.
