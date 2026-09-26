# Commit guard for Claude Code

The hook runs only before a Bash tool call containing `git commit`. It reads staged blobs through Git and blocks high-confidence secret formats, private-key material, sensitive filenames, oversized files, and `--no-verify`. Unresolved merge-conflict and debugger checks intentionally belong to the separately installable `debug-artifact-guard`.

When the same command stages content before the commit (`git add … && git commit`, `git stage`, `git rm`, and similar) or the commit reads the working tree (`-a`, `--all`, `--include`, `--only`, `--patch`, `--interactive`, `--pathspec-from-file`, or a pathspec), the hook also scans tracked files with unstaged changes and untracked, non-ignored files of the whole work tree. When `git add -f` or `git add --force` in the same command stages ignored files, the ignored files it names are scanned too, or every ignored file when the paths are not literal. That set is larger than what the commit can contain, so an unrelated untracked file with a secret also blocks; add it to `.gitignore` or stage explicitly in a separate command. More than 5000 candidate files block instead of being scanned partially.

The command is read with the toolkit's shared shell analysis: wrappers such as `sudo`, `env`, `nice`, `timeout`, and `xargs`, commands run by `find -exec`, static `sh -c`/`bash -c`/`eval` layers, executable paths such as `/usr/bin/git`, and Git global options such as `-C`, `-c`, and `--no-pager`. The words `xargs` appends count as pathspecs. Git aliases are resolved: those in Git configuration (read with `git config --get-regexp` only when the command uses a subcommand that is not built in), those defined earlier in the same command with `git config alias.<name>`, and `git -c alias.<name>=…`. `-n` inside an option group (`-nm`) and `-c core.hooksPath=…` count as `--no-verify`. A commit after `cd`, with `-C`/`--git-dir`/`--work-tree`, or from a shell alias (`!…`, which Git runs from the top of the work tree) blocks as `commit-scope-unsupported`; a dynamic alias definition or an alias loop blocks as `commit-command-uninspectable`.

The installed hook has no project-writable allowlist, rule ignore list, size override, environment bypass, or inline suppression. Such a mechanism could be authored by the same agent through Bash and would not authenticate human approval. Exceptional commits must be performed by a person outside the guarded agent session or after that person explicitly disables the exact hook entry.

## Refusals and limits

- The hook does not rewrite the index, delete a staged file, or alter the requested commit.
- It does not rotate, revoke, reveal, or transmit a discovered credential.
- It does not scan repository history or contact a network service.
- It does not run the project's tests or substitute for repository-native commit checks.
- It does not claim that its bounded pattern list is a complete secret scanner.
- It does not provide an agent-controlled runtime exception for a secret or sensitive path.
- It does not detect staging performed by a script or interpreter that the same command runs, or content that `git checkout <branch> -- <path>` brings from another commit.
- It does not know what `xargs` appends: those words are treated as pathspecs, so an appended `-n` is not seen.
- It reads the files the commit takes before the Bash command runs, not after. Another command earlier in the same command line is not executed by the hook, so its effect is not seen: `echo "$KEY" > config.js && git commit -am x` writes the key after the check. Run the change and the commit as separate tool calls so the commit is checked against the changed state.
