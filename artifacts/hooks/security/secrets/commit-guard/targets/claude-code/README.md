# Commit guard for Claude Code

The hook runs only before a Bash tool call containing `git commit`. It reads staged blobs through Git and blocks high-confidence secret formats, private-key material, sensitive filenames, oversized files, and `--no-verify`. Unresolved merge-conflict and debugger checks intentionally belong to the separately installable `debug-artifact-guard`.

The installed hook has no project-writable allowlist, rule ignore list, size override, environment bypass, or inline suppression. Such a mechanism could be authored by the same agent through Bash and would not authenticate human approval. Exceptional commits must be performed by a person outside the guarded agent session or after that person explicitly disables the exact hook entry.

## Refusals and limits

- The hook does not rewrite the index, delete a staged file, or alter the requested commit.
- It does not rotate, revoke, reveal, or transmit a discovered credential.
- It does not scan repository history or contact a network service.
- It does not run the project's tests or substitute for repository-native commit checks.
- It does not claim that its bounded pattern list is a complete secret scanner.
- It does not provide an agent-controlled runtime exception for a secret or sensitive path.
