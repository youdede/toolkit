# System service mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit lifecycle and configuration changes through systemd, launchd, SysV, and Windows service managers. Status, show, list, and query operations remain allowed. Its exported `evaluate(input)` policy is pure and does not inspect the host.

## Refusals and limits

- The hook does not start, stop, restart, enable, disable, mask, or reconfigure services.
- It does not determine whether a service name represents production, development, or disposable state.
- It does not inspect custom service wrappers, remote hosts, aliases, or shell functions.
- It does not accept prompt text, flags, or environment variables as authorization.
