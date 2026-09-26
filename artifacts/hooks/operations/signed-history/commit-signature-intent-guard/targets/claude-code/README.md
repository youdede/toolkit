# Commit signature intent guard for Claude Code

This hook checks signing intent before a Git command that creates a commit: `git commit` (also through a configured alias or one defined earlier in the same command), `git merge --no-ff`, `git cherry-pick`, `git revert`, and `git am`, unless `-n`/`--no-commit` or a recovery flag is given. Commands are read through the shared shell analysis (sequences, `sudo`, `eval`, `bash -c`). A plain `git merge` or `git pull` may fast-forward and `git rebase` replays commits, so they are not judged; a commit after `cd` or `git -C` without `-S` is refused because another repository's configuration cannot be read. Intent is satisfied by an explicit signing flag or by the effective read-only Git commit.gpgSign configuration.

Read-only Git commands, non-commit commands, explicitly signed commits, and commits under enabled commit.gpgSign configuration remain allowed.

Actual key availability, signature creation, cryptographic validity, and server-side verification are outside this pre-command boundary.

## Refusals

- It does not create, import, select, trust, unlock, rotate, or verify a signing key.
- It does not sign, commit, attest, push, or claim that a future signature will verify.
- It does not infer intent from branch names, commit messages, environment variables, aliases, or prompt text.
- It does not expose a project-controlled bypass or accept --no-gpg-sign.
- It reads the signing configuration before the Bash command runs, not after. Another command earlier in the same command line is not executed by the hook, so its effect is not seen: `git config commit.gpgSign false && git commit -m x` turns signing off after the check, so the commit is created unsigned. Run the change and the commit as separate tool calls so the commit is checked against the changed state.
