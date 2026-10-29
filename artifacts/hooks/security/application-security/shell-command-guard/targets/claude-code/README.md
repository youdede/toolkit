# Shell command guard for Claude Code

This project-scoped `PreToolUse` hook examines the Bash command supplied by Claude Code and exits with status 2 for named, high-confidence destructive patterns. It covers broad filesystem deletion, raw-disk writes, formatting, fork bombs, internet-to-shell pipelines, destructive Git/GitHub operations, explicit loss of uncommitted or stashed work, persistent container-volume deletion, cron-table removal, system-wide ownership changes, and credential-store access.

The rules deliberately allow ordinary project cleanup, Git dry runs, unstaging with `git restore --staged`, `git push --force-with-lease`, non-destructive container/GitHub calls, certificate listing, and normal HTTP downloads to files. Test any local policy change against both dangerous and safe controls.

The hook reads the command with the toolkit's shared shell item parser (`shell-items`) and matches it with the capability matcher (`capability`), both bounded and lexical. The parser reads quoting and escaping; wrappers such as `exec`, `time`, `command`, `env`, `sudo`, `nice`, `timeout`, `xargs`, and `find -exec`; static `sh -c`, `eval`, here-documents, and `echo`/`printf` feeds into a shell; compound commands; functions defined and called in the same command; executable paths such as `/bin/rm`; and Git global options such as `-C` and `-c`. Each rule sees one command, so text quoted inside an argument (`git commit -m "fix; rm -rf /"`) never matches, and every `rm` operand is checked. `git checkout -f` and `git switch -f`/`--discard-changes` count as discarding work. `git push --force-with-lease` passes alone; with `-f`, `--force`, or a `+refspec` in the same push it blocks, because Git then forces the update. Nothing is executed.

This hook also owns every program a command runs but does not contain, for itself and for the operation guards that install it as a prerequisite. A program fetched from the network and run is `internet-to-shell`: piped into a shell (`curl … | sh`, `bash <(curl …)`), piped into an interpreter that reads its program from standard input (`curl … | python3`, `| node`, `| perl`, `| ruby`, `| php`, `| deno run -`, `python3 <(curl …)`), or written to a file that the same command then runs (`curl -o i.sh … && sh i.sh`, `curl … > i.sh; bash i.sh`, `wget …/i.sh && chmod +x i.sh && ./i.sh`, a `tee` of the download, or an interpreter given the file). An interpreter with its own script or `-m` module reads the download as data (`curl … | python3 -m json.tool`). Any other such program (`eval "$X"`, `bash -c "$CMD"`, `python3 -c"$CODE"` in any attached or `=` form, a shell with no script and no `-c` whose input is not a static feed such as `{fd}<<< … bash`, `eval "$(some-tool emit)"`, `gh api … | base64 -d | sh`) is `shell-command-uninspectable`. Shell setup output is allowed: `eval "$(pyenv init -)"` and the same `init`, `env`, `shellenv`, `hook`, or `activate` forms of rbenv, nodenv, jenv, goenv, fnm, starship, direnv, zoxide, mise, brew, conda, and atuin; `eval "$(ssh-agent -s)"`; `source <(tool completion …)`. Local script files are allowed too (`bash script.sh`, `cat setup.sh | sh`, `sh < install.sh`). The command a package runner starts is judged too (`uv run rm -rf /`, `npx`, `pnpm dlx`, `npm exec`, `bundle exec`, `poetry run`). A dynamically selected executable blocks as uninspectable only when a static argument is evidence of a protected command (`$CMD -rf /`); `$CMD $ARGS` passes. A word that may expand to a protected spelling (`rm -rf "$DIR"` where the operand could be `/`), or a command the parser stops at (nesting deeper than 3, more than 256 KiB, unbalanced syntax), fails closed with `shell-command-uninspectable`.

## Refusals and limits

- The hook does not execute, rewrite, sanitize, or approve commands.
- It provides no hidden bypass and does not teach an agent how to evade a matched rule.
- It is not a complete shell parser, endpoint security product, sandbox, or authorization layer.
- It does not replace backups, protected branches, operating-system permissions, or human approval.
- It does not claim that a non-match makes a command safe.
- It does not inspect local script files or shell setup output (see above).
- Retained false positives: `$CMD /` and `"$EDITOR" /` are uninspectable, because `/` is root evidence for `rm`; an opaque executable (`$"x" -rf /`) is uninspectable.

Malformed or oversized hook input fails closed. Missing command fields are allowed because no Bash action was presented to inspect.

Retained false positives, each refused on purpose:

- `$CMD /` and `"$EDITOR" /` are uninspectable: `/` is evidence that a dynamic executable may be `rm`.
- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
