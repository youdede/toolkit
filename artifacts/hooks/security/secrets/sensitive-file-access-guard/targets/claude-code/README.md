# Sensitive file access guard for Claude Code

This project-scoped `PreToolUse` hook blocks direct `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and `Grep` access to high-confidence secret paths. It also analyzes static file operands and redirections in Bash and PowerShell commands. The reusable `evaluate(input, context)` core is deterministic and side-effect free; the Claude adapter supplies bounded filesystem metadata so aliases that resolve to a protected file cannot hide the target name.

Protected paths include environment files such as `.env` and `.env.production`, private SSH identities, and exact credential-store files for common cloud, package, container, Kubernetes, Git, and CLI clients. Template environment files ending in `.example`, `.sample`, `.template`, or `.dist` are allowed. The hook reads path metadata only: it never opens file contents and never includes submitted paths in diagnostics.

Malformed or oversized hook input fails closed. A known file-access command with a dynamic operand also fails closed because the protected path cannot be determined before execution. Irrelevant events and commands outside the documented file-access boundary are allowed.

Recursive reads (`grep -r`/`-R`/`--recursive`/`-d recurse`, `rg --hidden` or `-uu`, `tar`, `cp -r`/`-a`, `zip -r`) are blocked when the searched directory contains a protected file. `--exclude`, `--exclude-dir`, `--include` (grep), `--exclude` (tar), and `-g`/`--glob` (rg) are honoured for file and directory names. Plain `rg` skips hidden files and is checked the same way. `.git` is not walked. A tree larger than 20000 entries is blocked as uninspectable; narrow the path or exclude large directories.

## Refusals and limits

- The hook refuses to read, print, copy, redact, or transform protected file contents.
- It refuses project-controlled allowlists, environment-variable bypasses, and hidden override flags.
- It refuses to claim that a non-match proves a path, command, repository, or process is safe.
- It is not a complete shell parser, operating-system sandbox, endpoint monitor, or access-control system.
- It does not inspect paths constructed inside arbitrary Python, Node.js, compiled programs, or processes started after the guarded command.

Installation and removal are handled by the toolkit CLI as one-command, marker-scoped operations. The packaged runtime uses only Node.js built-ins.
