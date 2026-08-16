# Infrastructure apply guard for Claude Code

This project-scoped `PreToolUse` hook allows Terraform/OpenTofu plans, Pulumi previews, Kubernetes reads and diffs, and Helm rendering or status checks. It blocks explicit subcommands that mutate infrastructure, cluster resources, or release state. The pure `evaluate(input)` policy does not contact providers or inspect credentials.

## Refusals and limits

- The hook does not apply, destroy, import, unlock, or repair infrastructure state.
- It does not infer an environment or account from prompt text, variables, or local configuration.
- It does not parse custom wrappers, aliases, shell functions, or provider-specific plugins.
- It does not treat a custom `dry-run` string as proof that a mutating command is safe.
