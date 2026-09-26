# Cloud resource deletion guard for Claude Code

This project-scoped `PreToolUse` hook recognizes direct AWS, Google Cloud (`gcloud`, `gsutil`), and Azure CLI deletion, termination, removal, undeployment, and purge verbs, including `aws s3 rm`/`rb`, `gcloud storage rm`, and Azure `delete-*` forms. Read-only list, describe, get, and show operations pass. The exported `evaluate(input)` function is pure and never contacts provider APIs.

## Refusals and limits

- The hook does not delete, recover, snapshot, enumerate, or inspect cloud resources.
- It does not infer production status from account names, resource names, prompts, or environment variables.
- It does not cover custom cloud wrappers, aliases, SDK calls, or infrastructure-as-code commands.
- It reads each command through the shared shell analysis: wrappers such as `sudo`, `doas`, `env`, `nice`, and `timeout`, `sh -c`/`bash -c`/`eval`, `xargs`, `find -exec`, and the string literals of interpreter one-liners (`python -c`, `node -e`, `pwsh -c`). It does not see a command built at run time, a command inside `$(…)`, a script file, or a program that passes an argument list. A shell form the analysis cannot follow is refused only when the command text looks like a cloud CLI deletion.
- It does not accept CLI confirmation flags as proof of human authorization.
