# Sensitive file access guard for Claude Code

This project-scoped `PreToolUse` hook blocks direct `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and `Grep` access to high-confidence secret paths. It also analyzes static file operands and redirections in Bash and PowerShell commands. The reusable `evaluate(input, context)` core is deterministic and side-effect free; the Claude adapter supplies bounded filesystem metadata so aliases that resolve to a protected file cannot hide the target name.

Protected paths include environment files such as `.env` and `.env.production`, private SSH identities, and exact credential-store files for common cloud, package, container, Kubernetes, Git, and CLI clients. Template environment files ending in `.example`, `.sample`, `.template`, or `.dist` are allowed. The hook reads path metadata and directory listings only: it never opens file contents and never includes submitted paths in diagnostics.

## Commands it analyzes

Bash commands are read with the shared Youdede shell analysis, so every command behind `&&`, `||`, `;`, pipes, subshells, `sudo`, `doas`, `env`, `nice`, `timeout`, `setsid`, `exec`, `sh -c`, `bash -c`, `eval`, and `pwsh -Command` is checked. The hook looks at:

- the operands of `.`, `base64`, `bat`, `cat`, `chmod`, `chown`, `cmp`, `code`, `cp`, `curl`, `cut`, `dd`, `diff`, `head`, `install`, `less`, `ln`, `more`, `mv`, `nano`, `nl`, `od`, `rm`, `rsync`, `scp`, `sort`, `source`, `strings`, `tac`, `tail`, `tar`, `tee`, `type`, `uniq`, `vi`, `vim`, `wc`, `xxd`, `zip`, and the PowerShell `Copy-Item`, `Get-Content`/`gc`, `Move-Item`, `Out-File`, `Remove-Item`, `Select-String`, and `Set-Content`;
- the file operands of `grep`, `rg`, `awk`, `sed`, and `jq` after their pattern or program, and file options such as `grep -f`, `curl --netrc-file`, `curl -T`, `openssl -in`, and `dd if=`;
- `--env-file` values (`node --env-file=.env`, `docker run --env-file .env`), and the path in `git show <revision>:<path>` and `git cat-file`;
- redirections that read or write a file (`< .env`, `> out`), but not here-documents or `2>&1`;
- the files that `find -exec` runs a command on (its start paths, walked with hidden files and narrowed by `-name`/`-iname` unless `-o` is used), and the words that `xargs` receives from `echo`, `printf`, or `find`. Words `xargs` receives from any other command are unknown, and the command is blocked as uninspectable.

Other commands are outside the boundary and are allowed.

An unquoted glob (`wc -l src/*.js`) is expanded as bash does by default: `*`, `?`, and `[...]` match within one directory level, a leading dot must be written (`*` does not match `.env`, `.*` does), and every match is checked like a written path. After `cd` or `pushd` to a static path, later relative globs and recursive reads start there; after `popd`, `cd -`, a dynamic `cd`, or the end of a subshell, they are blocked as uninspectable. `**` (recursive in zsh), a glob with more than 1024 matches, and a directory listing past 20000 entries are blocked as uninspectable. Shell options such as `dotglob` or `nocaseglob` are not known to the hook.

Malformed or oversized hook input fails closed. A known file-access command with a dynamic operand, a dynamic executable, or a nested command that cannot be read also fails closed because the protected path cannot be determined before execution.

## Recursive reads

Recursive reads (`grep -r`/`-R`/`--recursive`/`-d recurse`, `rg --hidden` or `-uu`, `tar`, `cp -r`/`-a`, `zip -r`, `rsync -r`/`-a`, `scp -r`, and `find -exec`) are blocked when the searched directory contains a protected file. `--exclude`, `--exclude-dir`, `--include` (grep), `--exclude` (tar and rsync), and `-g`/`--glob` (rg) are honoured for file and directory names. For `rsync` and `scp` the last operand is the destination and is not walked. Plain `rg` skips hidden files and is checked the same way. `.git` is not walked. A tree larger than 20000 entries is blocked as uninspectable; narrow the path or exclude large directories.

The `Grep` tool is checked as a recursive read of its `path` (default: the working directory) and honours its `glob`; it reads hidden files (observed with Claude Code 2.1.282 on 2026-09-26). The `Grep` tool and `rg` (unless `-u`, `-uu`, `-uuu`, `--no-ignore`, or `--no-ignore-vcs` is given) skip files ignored by git, so inside a Git repository the hook asks `git ls-files` for the files they would visit, up to 200000; a gitignored `.env` is then not a reason to block. Submodules and nested repositories are walked without gitignore rules. Outside a Git repository, or when Git fails, the hook walks the directory as above. System `grep -r` reads gitignored files and is always checked with the walk.

## Refusals and limits

- The hook refuses to read, print, copy, redact, or transform protected file contents.
- It refuses project-controlled allowlists, environment-variable bypasses, and hidden override flags.
- It refuses to claim that a non-match proves a path, command, repository, or process is safe.
- It is not a complete shell parser, operating-system sandbox, endpoint monitor, or access-control system.
- It does not inspect paths constructed inside arbitrary Python, Node.js, compiled programs, or processes started after the guarded command.

Installation and removal are handled by the toolkit CLI as one-command, marker-scoped operations. The packaged runtime uses only Node.js built-ins.
