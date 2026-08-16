# User account mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit local user, group, password, and privilege-assignment changes through common Unix, macOS, and Windows account tools. Read-only identity commands remain allowed. The exported `evaluate(input)` policy is pure and does not inspect account databases.

## Refusals and limits

- The hook does not create, delete, rename, lock, unlock, or modify accounts or groups.
- It does not read, generate, set, expose, or rotate passwords and authentication material.
- It does not inspect directory services, cloud identity systems, custom wrappers, or remote machines.
- It does not infer authorization from an account name, prompt, environment variable, or CLI flag.
