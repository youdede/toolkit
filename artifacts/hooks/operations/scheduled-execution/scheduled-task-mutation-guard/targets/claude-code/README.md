# Scheduled task mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit task creation, alteration, execution, and deletion through cron, `at`, launchd, systemd timers, and Windows Task Scheduler, and writes of schedule files (`/etc/cron*`, `/var/spool/cron`, `Library/LaunchAgents` and `LaunchDaemons`, systemd `*.timer` units) through `tee`, `cp`, `mv`, `install`, `ln`, `rsync`, or a redirection. Read-only listing operations remain allowed. The exported `evaluate(input)` function has no side effects.

## Refusals and limits

- The hook does not create, run, edit, export, import, or delete scheduled tasks.
- It does not inspect existing scheduler databases, task XML, or launchd property lists.
- It does not recognize custom wrappers, aliases, APIs, or remote scheduler systems. The Claude Code adapter sees Bash only, so a native `Write` of a launchd property list is not seen.
- It reads each command through the shared shell analysis: wrappers such as `sudo`, `doas`, `env`, `nice`, and `timeout`, `sh -c`/`bash -c`/`eval`, `xargs`, `find -exec`, and the string literals of interpreter one-liners (`python -c`, `node -e`, `pwsh -c`, also attached as `-c"…"` or `--eval=…`) when the program's code, outside its literals and comments, calls something that runs commands (`os.system`, `child_process`, `system`, and similar); without such a call the literals are data. Ruby `%q{…}` and Perl `q{…}` literals count as literals. A one-liner whose program is known only at run time counts as a form the analysis cannot follow. It does not see a command built at run time, a command inside `$(…)`, a script file, or a program that passes an argument list. A shell form the analysis cannot follow is refused only when the command text looks like a scheduler command or schedule file.
- It does not infer human approval from a task name, comment, prompt, or flag.
