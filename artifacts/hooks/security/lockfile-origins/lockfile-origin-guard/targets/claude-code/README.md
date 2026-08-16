# Lockfile origin guard for Claude Code

This hook examines staged lockfile metadata only when a Git commit is attempted. It reports stable rule identifiers without echoing origin URLs or integrity material.

HTTPS package origins with integrity metadata, lockfiles not staged for commit, and unrelated Git commands remain allowed.

The first scanner covers npm package-lock JSON. Unsupported lockfile formats are ignored rather than treated as validated.

## Refusals

- It does not regenerate, normalize, sign, install, or verify the full dependency graph.
- It does not send package origins, credentials, integrity values, or repository content anywhere.
- It does not claim that an accepted lockfile is reproducible, authentic, or vulnerability-free.
- It does not allow command flags or repository files to disable a detected origin violation.
