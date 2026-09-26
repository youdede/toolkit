# Lockfile origin guard for Claude Code

This hook examines lockfile metadata only when a Git commit is attempted. It reads the command through the shared shell and commit-content analysis, so wrappers (`sudo`, `time`, `env`, `eval`, `sh -c`) and Git aliases are resolved. It inspects the staged lockfiles and, when the commit takes working-tree content (`-a`, a pathspec, or `git add` earlier in the same command), the changed or untracked lockfiles on disk. It reports stable rule identifiers without echoing origin URLs or integrity material.

HTTPS package origins with integrity metadata, lockfiles the commit does not take, and unrelated Git commands remain allowed. A commit after `cd` or with `git -C`/`--git-dir`/`--work-tree` is refused as uninspectable.

The first scanner covers npm package-lock JSON. Unsupported lockfile formats are ignored rather than treated as validated.

## Refusals

- It does not regenerate, normalize, sign, install, or verify the full dependency graph.
- It does not send package origins, credentials, integrity values, or repository content anywhere.
- It does not claim that an accepted lockfile is reproducible, authentic, or vulnerability-free.
- It does not allow command flags or repository files to disable a detected origin violation.
- It reads the lockfiles the commit takes before the Bash command runs, not after. Another command earlier in the same command line is not executed by the hook, so its effect is not seen: `npm install left-pad && git commit -am deps` rewrites the lockfile after the check. Run the change and the commit as separate tool calls so the commit is checked against the changed state.
