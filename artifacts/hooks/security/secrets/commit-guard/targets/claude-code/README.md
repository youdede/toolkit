# Commit guard for Claude Code

The hook runs only before a Bash tool call containing `git commit`. It reads staged blobs through Git and blocks high-confidence secret formats, private-key material, sensitive filenames, oversized files, and `--no-verify`. Unresolved merge-conflict and debugger checks intentionally belong to the separately installable `debug-artifact-guard`.

When the same command stages content before the commit (`git add … && git commit`, `git stage`, `git rm`, and similar) or the commit reads the working tree (`-a`, `--all`, `--include`, `--only`, `--patch`, `--interactive`, `--pathspec-from-file`, or a pathspec), the hook also scans tracked files with unstaged changes and untracked, non-ignored files. That set is larger than what the commit can contain, so an unrelated untracked file with a secret also blocks; add it to `.gitignore` or stage explicitly in a separate command. More than 5000 candidate files block instead of being scanned partially.

The installed hook has no project-writable allowlist, rule ignore list, size override, environment bypass, or inline suppression. Such a mechanism could be authored by the same agent through Bash and would not authenticate human approval. Exceptional commits must be performed by a person outside the guarded agent session or after that person explicitly disables the exact hook entry.

## Refusals and limits

- The hook does not rewrite the index, delete a staged file, or alter the requested commit.
- It does not rotate, revoke, reveal, or transmit a discovered credential.
- It does not scan repository history or contact a network service.
- It does not run the project's tests or substitute for repository-native commit checks.
- It does not claim that its bounded pattern list is a complete secret scanner.
- It does not provide an agent-controlled runtime exception for a secret or sensitive path.
- It does not detect staging performed by a script, interpreter, or alias that the same command runs.
