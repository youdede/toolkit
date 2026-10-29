# Install lifecycle script guard for Claude Code

This hook protects the automatic execution boundary of package installation. It compares lifecycle script keys structurally and blocks net-new lifecycle entries and changes to the command of an existing lifecycle entry.

Ordinary test, build, lint, and development scripts are outside this boundary. Removing or preserving an existing lifecycle entry is allowed.

It scans JSON package manifests written with Write, Edit, or MultiEdit, and Bash commands `npm pkg set scripts.<lifecycle>=…` (also `scripts[<lifecycle>]` and a JSON `scripts=` value) and `npm set-script <lifecycle>`, read through the shared item parser. Other shell edits of package.json (`jq`, redirection, editors) are not inspected. It has no project-writable allowlist, environment bypass, or inline suppression.

A program the command runs but does not contain (`bash -c "$CMD"`, `curl … | sh`, `eval "$(tool)"`, `python3 -c "$CODE"`) is judged by shell-command-guard; this hook refuses one only when its text names `npm pkg set scripts`, `npm set-script`.

## Refusals

- It does not execute, sandbox, review, rewrite, or approve any package script.
- It does not claim that non-lifecycle scripts or existing lifecycle scripts are safe.
- It does not infer authorization from script names, comments, environment variables, or prompt text.
- It does not provide an agent-controlled exception file or inline bypass.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add install-lifecycle-script-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives, each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
