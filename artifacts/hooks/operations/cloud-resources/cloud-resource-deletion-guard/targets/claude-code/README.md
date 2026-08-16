# Cloud resource deletion guard for Claude Code

This project-scoped `PreToolUse` hook recognizes direct AWS, Google Cloud, and Azure CLI deletion, termination, removal, undeployment, and purge verbs. Read-only list, describe, get, and show operations pass. The exported `evaluate(input)` function is pure and never contacts provider APIs.

## Refusals and limits

- The hook does not delete, recover, snapshot, enumerate, or inspect cloud resources.
- It does not infer production status from account names, resource names, prompts, or environment variables.
- It does not cover custom cloud wrappers, aliases, SDK calls, or infrastructure-as-code commands.
- It does not accept CLI confirmation flags as proof of human authorization.
