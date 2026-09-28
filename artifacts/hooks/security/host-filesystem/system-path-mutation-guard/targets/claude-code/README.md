# System path mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks common file-mutating commands whose static destination is under protected Unix, macOS, or Windows operating-system paths (`/etc`, `/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `C:\Windows\System32`, `C:\Program Files`). It is deliberately separate from workspace-native edit containment and from service, scheduler, firewall, and account administration.

The hook reads the Bash command with the shared item parser, so it sees each command behind `&&`, `||`, `;`, pipes, subshells, groups, `sudo`, `doas`, `env`, `nice`, `timeout`, `setsid`, `exec`, `xargs`, `find -exec`, `sh -c`, `bash -c`, `eval`, and `pwsh -Command`. It checks:

- the destination of `cp`, `mv`, and `ln` (or their `-t` directory), and every operand of `install`, `chmod`, `chown`, `chgrp`, `truncate`, `touch`, `mkdir`, `rmdir`, `tee`, `rm`, `unlink`, and `shred`;
- the files that `sed -i` and `perl -i` edit in place, and the `of=` operand of `dd`;
- redirections that write a file (`>`, `>>`, `>|`, `&>`, `<>`).

Paths are normalized first, so `/tmp/../etc/hosts`, `//etc/hosts`, and `C:\Windows\System32\...` inside single quotes are recognized. A glob right after `/` (`rm -rf /*`) can reach a protected root and is blocked. A command the parser stops at (an unterminated quote, nesting deeper than 3, more than 256 KiB) is blocked as uninspectable. A dynamic executable is uninspectable only when an operand can name a protected root (`"$EDITOR" file` passes). A dynamic destination of `cp`, `mv`, `ln`, `install`, `chmod`, `chown`, `chgrp`, `truncate`, `touch`, `mkdir`, `rmdir`, or `tee` is blocked unless it starts with a static relative path or with `$HOME`, `$PWD`, `$TMPDIR`, or `~`; for `rm`, `unlink`, `shred`, `sed -i`, `perl -i`, `dd`, and redirections, a dynamic operand is blocked only when its static prefix is already protected. Operands that `xargs` or `find -exec` supply at run time are treated the same way.

A program the command runs but does not contain (`bash -c "$CMD"`, `curl … | sh`, `eval "$(tool)"`, `python3 -c "$CODE"`) is judged by shell-command-guard; this hook refuses one only when its text names `/etc/`, `/usr/`, `/bin/`, `/sbin/`, `/System/`, `/Library/`.

## Refusals and limits

- The hook does not modify, inspect, repair, or restore operating-system files.
- It does not resolve variables, command substitutions, aliases, functions, or filesystem symlinks, and it does not resolve relative paths against the working directory.
- It does not cover every possible interpreter or custom utility capable of writing a file.
- On Claude Code it is bound to the `Bash` tool only; commands run through the `PowerShell` tool on Windows are not inspected, and PowerShell cmdlets such as `Copy-Item` or `Set-Content` are not in the list above.
- It does not replace OS permissions, containers, sandboxes, or least-privilege execution.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add system-path-mutation-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.
