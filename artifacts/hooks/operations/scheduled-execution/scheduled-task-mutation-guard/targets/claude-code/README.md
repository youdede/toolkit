# Scheduled task mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit task creation, alteration, execution, and deletion through cron, `at`, launchd, systemd timers, and Windows Task Scheduler, and writes of schedule files (`/etc/cron*`, `/var/spool/cron`, `Library/LaunchAgents` and `LaunchDaemons`, systemd `*.timer` units) through `tee`, `cp`, `mv`, `install`, `ln`, `rsync`, or a redirection. Read-only listing operations remain allowed. The exported `evaluate(input)` function has no side effects.

The command a package runner starts is judged like a direct one (`uv run`, `npx`, `pnpm dlx`, `npm exec`, `bundle exec`, `poetry run`, for example `uv run aws ec2 terminate-instances …`).

## Refusals and limits

- The hook does not create, run, edit, export, import, or delete scheduled tasks.
- It does not inspect existing scheduler databases, task XML, or launchd property lists.
- It does not recognize custom wrappers, aliases, APIs, or remote scheduler systems. The Claude Code adapter sees Bash only, so a native `Write` of a launchd property list is not seen.
- It reads each command with the shared shell item parser and capability matcher: wrappers such as `sudo`, `doas`, `env`, `nice`, `timeout`, `xargs`, and `find -exec`; static `sh -c`, `eval`, here-documents, and `echo`/`printf` feeds into a shell; functions defined and called in the same command; and the options that take a value, so the verb is found wherever it sits. A word that may expand to a protected verb, or a command the parser stops at (nesting deeper than 3, more than 256 KiB, unbalanced syntax), is uninspectable. Interpreter one-liners (`python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `deno eval`) are read when the program can run a command (a module such as `subprocess` or `child_process`, a call such as `system`, backticks, or `eval`): if its text or one of its string literals, joined and with escapes decoded, concerns what the hook protects, the command is uninspectable, never the concrete rule, because the program may not run it. Such a program that only prints the command is refused too (a retained false positive). A program that names nothing of the kind passes, and a command built at run time from pieces that do not name it is not seen. An opaque executable (`$"x" …`) is uninspectable.
- It does not infer human approval from a task name, comment, prompt, or flag.
- Programs the command runs but does not contain (`curl … | sh`, `eval "$X"`, `bash -c "$CMD"`) are refused by shell-command-guard, installed as a prerequisite. Local script files (`bash script.sh`) and shell setup output (`eval "$(pyenv init -)"`, `source <(kubectl completion bash)`) are not inspected.

Retained false positives (hook-design 4.3), each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
