# Shell command guard for Claude Code

This project-scoped `PreToolUse` hook examines the Bash command supplied by Claude Code and exits with status 2 for named, high-confidence destructive patterns. It covers broad filesystem deletion, raw-disk writes, formatting, fork bombs, internet-to-shell pipelines, destructive Git/GitHub operations, explicit loss of uncommitted or stashed work, persistent container-volume deletion, cron-table removal, system-wide ownership changes, and credential-store access.

The rules deliberately allow ordinary project cleanup, Git dry runs, unstaging with `git restore --staged`, `git push --force-with-lease`, non-destructive container/GitHub calls, certificate listing, and normal HTTP downloads to files. Test any local policy change against both dangerous and safe controls.

Before matching, the hook normalizes the command with the toolkit's shared shell analysis, which is bounded and lexical: literal quoting and escaping; the wrappers `exec`, `time`, `noglob`, `command`, `env`, `sudo`, `nice`, `timeout`, and `xargs`; commands run by `find -exec`; static `sh`/`bash`/`zsh` `-c` and `eval` layers; `if`/`then`/`do` and `{ … }` compound commands; executable paths such as `/bin/rm`; and Git global options such as `-C`, `-c`, and `--no-pager`. Each rule sees one normalized command, so text quoted inside an argument (`git commit -m "fix; rm -rf /"`) never matches, and every `rm` operand is checked. `git checkout -f` and `git switch -f`/`--discard-changes` count as discarding work. `git push --force-with-lease` passes alone; with `-f`, `--force`, or a `+refspec` in the same push it blocks, because Git then forces the update. It never executes expansions and does not inspect the inside of `$(…)`. A dynamically selected executable, a process substitution passed to a shell (`bash <(curl …)`), a malformed shell envelope, or a dynamic control argument for a protected command fails closed with `shell-command-uninspectable`.

## Refusals and limits

- The hook does not execute, rewrite, sanitize, or approve commands.
- It provides no hidden bypass and does not teach an agent how to evade a matched rule.
- It is not a complete shell parser, endpoint security product, sandbox, or authorization layer.
- It does not replace backups, protected branches, operating-system permissions, or human approval.
- It does not claim that a non-match makes a command safe.

Malformed or oversized hook input fails closed. Missing command fields are allowed because no Bash action was presented to inspect.
