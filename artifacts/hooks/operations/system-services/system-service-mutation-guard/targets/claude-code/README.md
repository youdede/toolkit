# System service mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit lifecycle and configuration changes through systemd, launchd, SysV, Homebrew services, and Windows service managers, including PowerShell service cmdlets inside `pwsh -c`. Status, show, list, and query operations remain allowed. Its exported `evaluate(input)` policy is pure and does not inspect the host.

## Refusals and limits

- The hook does not start, stop, restart, enable, disable, mask, or reconfigure services.
- It does not determine whether a service name represents production, development, or disposable state.
- It does not inspect custom service wrappers, remote hosts, aliases, or shell functions.
- It reads each command through the shared shell analysis: wrappers such as `sudo`, `doas`, `env`, `nice`, and `timeout`, `sh -c`/`bash -c`/`eval`, `xargs`, `find -exec`, and the string literals of interpreter one-liners (`python -c`, `node -e`, `pwsh -c`). It does not see a command built at run time, a command inside `$(…)`, a script file, or a program that passes an argument list. A shell form the analysis cannot follow is refused only when the command text looks like a service manager command.
- It does not accept prompt text, flags, or environment variables as authorization.
