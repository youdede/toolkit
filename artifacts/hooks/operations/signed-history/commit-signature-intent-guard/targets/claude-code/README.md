# Commit signature intent guard for Claude Code

This hook checks signing intent before a direct Git commit. Intent is satisfied by an explicit signing flag or by the effective read-only Git commit.gpgSign configuration.

Read-only Git commands, non-commit commands, explicitly signed commits, and commits under enabled commit.gpgSign configuration remain allowed.

Actual key availability, signature creation, cryptographic validity, and server-side verification are outside this pre-command boundary.

## Refusals

- It does not create, import, select, trust, unlock, rotate, or verify a signing key.
- It does not sign, commit, attest, push, or claim that a future signature will verify.
- It does not infer intent from branch names, commit messages, environment variables, aliases, or prompt text.
- It does not expose a project-controlled bypass or accept --no-gpg-sign.
