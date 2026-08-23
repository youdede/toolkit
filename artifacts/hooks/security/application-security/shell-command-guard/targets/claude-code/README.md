# Shell command guard for Claude Code

This project-scoped `PreToolUse` hook examines the Bash command supplied by Claude Code and exits with status 2 for named, high-confidence destructive patterns. It covers broad filesystem deletion, raw-disk writes, formatting, fork bombs, internet-to-shell pipelines, destructive Git/GitHub operations, explicit loss of uncommitted or stashed work, persistent container-volume deletion, cron-table removal, system-wide ownership changes, and credential-store access.

The rules deliberately allow ordinary project cleanup, Git dry runs, unstaging with `git restore --staged`, `git push --force-with-lease`, non-destructive container/GitHub calls, certificate listing, and normal HTTP downloads to files. Test any local policy change against both dangerous and safe controls.

Before matching, the hook performs bounded lexical normalization of literal quoting and escaping, `exec`, `time`, `noglob`, `command`, `env`, `sudo`, and static `sh`/`bash`/`zsh` `-c` layers. It never executes expansions. A dynamically selected executable, malformed shell envelope, or dynamic control argument for a protected command fails closed with `shell-command-uninspectable`.

## Refusals and limits

- The hook does not execute, rewrite, sanitize, or approve commands.
- It provides no hidden bypass and does not teach an agent how to evade a matched rule.
- It is not a complete shell parser, endpoint security product, sandbox, or authorization layer.
- It does not replace backups, protected branches, operating-system permissions, or human approval.
- It does not claim that a non-match makes a command safe.

Malformed, oversized, or missing Bash command input fails closed. Irrelevant tool events remain outside the adapter matcher and therefore never reach this hook.
