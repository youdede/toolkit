# database-query-mode-guard

Extracts bounded SQL from recognized CLI flags or structured query fields (every command the shell would run is searched, including those inside `sh -c`, `eval`, `sudo`, `env`, `xargs`, and `find -exec`; `SELECT … INTO` counts as a write), masks comments and literals, and permits only read-oriented statement forms at a live execution boundary.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

A program the command runs but does not contain (`bash -c "$CMD"`, `curl … | sh`, `eval "$(tool)"`, `python3 -c "$CODE"`) is judged by shell-command-guard; this hook refuses one only when its text names `psql`, `mysql`, `mariadb`, `sqlcmd`, `sqlite3`, `invoke-sqlcmd`.

## Refusals and limits

- It does not inspect migration files or database schema changes.
- It does not connect to a database or execute EXPLAIN.
- It does not treat stored procedures as read-only without an explicit static contract.
- It does not inspect SQL sent from interpreters, scripts, or application code.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add database-query-mode-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives, each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
