# Install lifecycle script guard for Claude Code

This hook protects the automatic execution boundary of package installation. It compares lifecycle script keys structurally and blocks only net-new executable entries.

Ordinary test, build, lint, and development scripts are outside this boundary. Removing or preserving an existing lifecycle entry is allowed.

Version one scans JSON package manifests. It has no project-writable allowlist, environment bypass, or inline suppression.

## Refusals

- It does not execute, sandbox, review, rewrite, or approve any package script.
- It does not claim that non-lifecycle scripts or existing lifecycle scripts are safe.
- It does not infer authorization from script names, comments, environment variables, or prompt text.
- It does not provide an agent-controlled exception file or inline bypass.
