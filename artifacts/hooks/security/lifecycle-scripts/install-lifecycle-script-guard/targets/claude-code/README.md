# Install lifecycle script guard for Claude Code

This hook protects the automatic execution boundary of package installation. It compares lifecycle script keys structurally and blocks net-new lifecycle entries and changes to the command of an existing lifecycle entry.

Ordinary test, build, lint, and development scripts are outside this boundary. Removing or preserving an existing lifecycle entry is allowed.

It scans JSON package manifests written with Write, Edit, or MultiEdit, and Bash commands `npm pkg set scripts.<lifecycle>=…` (also `scripts[<lifecycle>]` and a JSON `scripts=` value) and `npm set-script <lifecycle>`, read through the shared shell analysis. Other shell edits of package.json (`jq`, redirection, editors) are not inspected. It has no project-writable allowlist, environment bypass, or inline suppression.

## Refusals

- It does not execute, sandbox, review, rewrite, or approve any package script.
- It does not claim that non-lifecycle scripts or existing lifecycle scripts are safe.
- It does not infer authorization from script names, comments, environment variables, or prompt text.
- It does not provide an agent-controlled exception file or inline bypass.
