# System path mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks common file-mutating commands whose static destination is under protected Unix, macOS, or Windows operating-system paths. It is deliberately separate from workspace-native edit containment and from service, scheduler, firewall, and account administration.

## Refusals and limits

- The hook does not modify, inspect, repair, or restore operating-system files.
- It does not resolve variables, command substitutions, aliases, functions, or filesystem symlinks.
- It does not cover every possible interpreter or custom utility capable of writing a file.
- It does not replace OS permissions, containers, sandboxes, or least-privilege execution.
