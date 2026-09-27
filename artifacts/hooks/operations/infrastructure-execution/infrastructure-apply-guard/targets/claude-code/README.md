# Infrastructure apply guard for Claude Code

This project-scoped `PreToolUse` hook allows Terraform/OpenTofu plans, Pulumi previews, Kubernetes reads and diffs, and Helm rendering or status checks. It blocks explicit subcommands that mutate infrastructure, cluster resources, or release state. The pure `evaluate(input)` policy does not contact providers or inspect credentials.

## Refusals and limits

- The hook does not apply, destroy, import, unlock, or repair infrastructure state.
- It does not infer an environment or account from prompt text, variables, or local configuration.
- It does not parse custom wrappers, aliases, or provider-specific plugins. A shell function that passes `"$@"` to a guarded CLI is refused because its subcommand is unknown.
- It reads each command through the shared shell analysis: wrappers such as `sudo`, `doas`, `env`, `nice`, and `timeout`, `sh -c`/`bash -c`/`eval`, `xargs`, `find -exec`, and the string literals of interpreter one-liners (`python -c`, `node -e`, `pwsh -c`, also attached as `-c"…"` or `--eval=…`) when the program calls something that runs commands (`os.system`, `child_process`, `system`, and similar); without such a call the literals are data. A one-liner whose program is known only at run time counts as a form the analysis cannot follow. It does not see a command built at run time, a command inside `$(…)`, a script file, or a program that passes an argument list. A shell form the analysis cannot follow is refused only when the command text looks like a Terraform, OpenTofu, Pulumi, kubectl, or Helm command.
- It does not treat a custom `dry-run` string as proof that a mutating command is safe.
