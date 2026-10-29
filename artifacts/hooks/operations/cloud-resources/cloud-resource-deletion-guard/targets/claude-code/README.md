# Cloud resource deletion guard for Claude Code

This project-scoped `PreToolUse` hook recognizes direct AWS, Google Cloud (`gcloud`, `gsutil`), and Azure CLI deletion, termination, removal, undeployment, and purge verbs, including `aws s3 rm`/`rb`, `gcloud storage rm`, and Azure `delete-*` forms. Read-only list, describe, get, and show operations pass. The exported `evaluate(input)` function is pure and never contacts provider APIs.

The command a package runner starts is judged like a direct one (`uv run`, `npx`, `pnpm dlx`, `npm exec`, `bundle exec`, `poetry run`, for example `uv run aws ec2 terminate-instances …`).

## Refusals and limits

- The hook does not delete, recover, snapshot, enumerate, or inspect cloud resources.
- It does not infer production status from account names, resource names, prompts, or environment variables.
- It does not cover custom cloud wrappers, aliases, SDK calls, or infrastructure-as-code commands.
- It reads each command with the shared shell item parser and capability matcher: wrappers such as `sudo`, `doas`, `env`, `nice`, `timeout`, `xargs`, and `find -exec`; static `sh -c`, `eval`, here-documents, and `echo`/`printf` feeds into a shell; functions defined and called in the same command; and the options that take a value, so the verb is found wherever it sits. A word that may expand to a protected verb, or a command the parser stops at (nesting deeper than 3, more than 256 KiB, unbalanced syntax), is uninspectable. Interpreter one-liners (`python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `deno eval`) are read when the program can run a command (a module such as `subprocess` or `child_process`, a call such as `system`, backticks, or `eval`): if its text or one of its string literals, joined and with escapes decoded, concerns what the hook protects, the command is uninspectable, never the concrete rule, because the program may not run it. Such a program that only prints the command is refused too (a retained false positive). A program that names nothing of the kind passes, and a command built at run time from pieces that do not name it is not seen. An opaque executable (`$"x" …`) is uninspectable.
- It does not accept CLI confirmation flags as proof of human authorization.
- Programs the command runs but does not contain (`curl … | sh`, `eval "$X"`, `bash -c "$CMD"`) are refused by shell-command-guard, installed as a prerequisite. Local script files (`bash script.sh`) and shell setup output (`eval "$(pyenv init -)"`, `source <(kubectl completion bash)`) are not inspected.

Retained false positives, each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
