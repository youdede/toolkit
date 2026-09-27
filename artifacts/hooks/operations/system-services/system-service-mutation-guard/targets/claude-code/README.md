# System service mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit lifecycle and configuration changes through systemd, launchd, SysV, Homebrew services, and Windows service managers, including PowerShell service cmdlets inside `pwsh -c`. Status, show, list, and query operations remain allowed. Its exported `evaluate(input)` policy is pure and does not inspect the host.

## Refusals and limits

- The hook does not start, stop, restart, enable, disable, mask, or reconfigure services.
- It does not determine whether a service name represents production, development, or disposable state.
- It does not inspect custom service wrappers, remote hosts, aliases, or shell functions.
- It reads each command through the shared shell analysis: wrappers such as `sudo`, `doas`, `env`, `nice`, and `timeout`, `sh -c`/`bash -c`/`eval`, `xargs`, `find -exec`, and the string literals of interpreter one-liners (`python -c`, `node -e`, `pwsh -c`, also attached as `-c"…"` or `--eval=…`) when the program's code, outside its literals and comments, names something that can run a command (a module such as `subprocess` or `child_process`, a call such as `system`, backticks, or a dynamic name such as `getattr` or `eval`); otherwise the literals are data and the command passes. With such a name every literal counts as a command, even one the program only prints, and such a program with a here-document or a dynamic name counts as a form the analysis cannot follow. Any program the reader does not follow to the end (more than 256 literals, deep interpolation, an unterminated literal) counts as one too, whatever it names. A one-liner whose program is known only at run time counts as a form the analysis cannot follow. It does not see a command built at run time, a command inside `$(…)`, a script file, or a program that passes an argument list. A shell form the analysis cannot follow is refused only when the command text looks like a service manager command.
- It does not accept prompt text, flags, or environment variables as authorization.
