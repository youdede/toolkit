# Policy file guard for Claude Code

The hook runs before Write or Edit and blocks modifications to existing lint, format, ownership, and dependency-policy files inside the project. It permits first-time creation because no existing policy is being weakened.

The hook has no project-writable allowlist or configuration extension. Because the same agent can invoke Bash, a repository exception file cannot authenticate human approval. A person must make any intentional policy change outside the guarded agent session or explicitly disable and later restore the exact hook entry.

## Refusals and limits

- The hook does not edit, replace, or repair a protected policy file.
- It does not decide whether a requested policy change is legitimate or grant an exception implicitly.
- It does not protect arbitrary files outside the project root.
- It does not intercept shell commands (Bash) that modify a policy file.
- It does not expose a project file, inline suppression, or environment variable that bypasses protection.
- It does not claim that the protected-basename list covers every repository policy.
