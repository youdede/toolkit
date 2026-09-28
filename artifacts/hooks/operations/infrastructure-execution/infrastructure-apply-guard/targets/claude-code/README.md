# Infrastructure apply guard for Claude Code

This project-scoped `PreToolUse` hook allows Terraform/OpenTofu plans, Pulumi previews, Kubernetes reads and diffs, and Helm rendering or status checks. It blocks explicit subcommands that mutate infrastructure, cluster resources, or release state. The pure `evaluate(input)` policy does not contact providers or inspect credentials.

The command a package runner starts is judged like a direct one (`uv run`, `npx`, `pnpm dlx`, `npm exec`, `bundle exec`, `poetry run`, for example `uv run aws ec2 terminate-instances …`).

## Refusals and limits

- The hook does not apply, destroy, import, unlock, or repair infrastructure state.
- It does not infer an environment or account from prompt text, variables, or local configuration.
- It does not parse custom wrappers, aliases, or provider-specific plugins. A shell function that passes `"$@"` to a guarded CLI is refused because its subcommand is unknown.
- It reads each command with the shared shell item parser and capability matcher: wrappers such as `sudo`, `doas`, `env`, `nice`, `timeout`, `xargs`, and `find -exec`; static `sh -c`, `eval`, here-documents, and `echo`/`printf` feeds into a shell; functions defined and called in the same command; and the options that take a value, so the verb is found wherever it sits. A word that may expand to a protected verb, or a command the parser stops at (nesting deeper than 3, more than 256 KiB, unbalanced syntax), is uninspectable. Interpreter one-liners (`python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `deno eval`) are read when the program can run a command (a module such as `subprocess` or `child_process`, a call such as `system`, backticks, or `eval`): if its text or one of its string literals, joined and with escapes decoded, concerns what the hook protects, the command is uninspectable, never the concrete rule, because the program may not run it. Such a program that only prints the command is refused too (a retained false positive). A program that names nothing of the kind passes, and a command built at run time from pieces that do not name it is not seen. An opaque executable (`$"x" …`) is uninspectable.
- It does not treat a custom `dry-run` string as proof that a mutating command is safe.
- Programs the command runs but does not contain (`curl … | sh`, `eval "$X"`, `bash -c "$CMD"`) are refused by shell-command-guard, installed as a prerequisite. Local script files (`bash script.sh`) and shell setup output (`eval "$(pyenv init -)"`, `source <(kubectl completion bash)`) are not inspected.

Retained false positives (hook-design 4.3), each refused on purpose:

- `kubectl apply --dry-run=server` and `helm … --dry-run=server` are refused: a server-side dry run is not a verified safe mode.
- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
- An option the hook has not verified, before a safe option (`pulumi refresh --unknown --preview-only`), is read both ways, so the safe mode does not count; verifying the option into the CLI fixture fixes it.
