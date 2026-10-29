# Commit guard for Claude Code

The hook runs only before a Bash tool call containing `git commit`. It reads staged blobs through Git and blocks high-confidence secret formats, private-key material, sensitive filenames, oversized files, and `--no-verify`. Unresolved merge-conflict and debugger checks intentionally belong to the separately installable `debug-artifact-guard`.

The credential formats are the 117 rules of the hook's `secret-rules` block, shared with prompt-secret-guard and the repository scan: private key headers and the provider prefixes or fixed structures of cloud, source-control, registry, CI/CD, observability, messaging, payment, and AI services. A format that needs a keyword next to the value, an entropy guess, a bare hex string, a UUID, or a JWT is not a rule, because those shapes also match hashes, identifiers, and documentation samples.

The sensitive filenames come from the shared `sensitive-paths` block, also behind sensitive-file-access-guard and the read-only MCP servers. A commit is refused for every file those refuse to read (environment files, private SSH identities, credential directories such as `.aws` and `.kube`, and stores such as `.git-credentials`, `.netrc`, `.pypirc`, and `.docker/config.json`), plus key and keystore files (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`) and `credentials`/`secrets` files. A project `.npmrc` may be committed for its registry settings; an npm token inside it is still caught as content.

When the same command stages content before the commit (`git add … && git commit`, `git stage`, `git rm`, and similar) or the commit reads the working tree (`-a`, `--all`, `--include`, `--only`, `--patch`, `--interactive`, `--pathspec-from-file`, or a pathspec), the hook also scans tracked files with unstaged changes and untracked, non-ignored files of the whole work tree. That set is larger than what the commit can contain, so an unrelated untracked file with a secret also blocks; add it to `.gitignore` or stage explicitly in a separate command. More than 5000 candidate files block instead of being scanned partially.

The command is read with the toolkit's shared shell item parser and commit-content analysis: wrappers such as `sudo`, `env`, `nice`, `timeout`, and `xargs`, commands run by `find -exec`, static `sh -c`/`bash -c`/`eval` layers, functions called in the same command, executable paths such as `/usr/bin/git`, and Git global options such as `-C`, `-c`, and `--no-pager`. The words `xargs` appends count as pathspecs. `-n` inside an option group (`-nm`) and `-c core.hooksPath=…` count as `--no-verify`. A commit after `cd`, with `-C`/`--git-dir`/`--work-tree`, or with a `GIT_DIR`/`GIT_WORK_TREE` assignment blocks as `commit-scope-unsupported`. Configured Git aliases are followed one level (read with `git config --get-regexp` only for a subcommand that is not built in). A commit in the same command as `git add -f`, an alias definition (`git config alias.<name>`, `git -c alias.<name>=…`), a shell alias (`!…`), or an alias of an alias is refused as `commit-sequence-unsupported`: run them as separate tool calls. A program the command runs but does not contain (`bash -c "$X"`, `curl … | sh`) is left to shell-command-guard. A subcommand or alias value known only at run time blocks as `commit-command-uninspectable`.

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

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add commit-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives, each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
