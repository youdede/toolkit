# User account mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit local user, group, password, and privilege-assignment changes through common Unix, macOS, and Windows account tools. Read-only identity commands remain allowed. The exported `evaluate(input)` policy is pure and does not inspect account databases.

The hook reads the Bash command with the shared item parser, so it sees each command behind `&&`, `||`, `;`, pipes, subshells, `sudo`, `doas`, `env`, `nice`, `timeout`, `setsid`, `exec`, `xargs`, `find -exec`, `sh -c`, `bash -c`, `eval`, and `pwsh -Command`. It blocks:

- Unix: `useradd`, `adduser`, `userdel`, `deluser`, `usermod`, `groupadd`, `addgroup`, `groupdel`, `delgroup`, `groupmod`, `gpasswd`, `chpasswd`, `passwd`, `newusers`, `chage`, and `pw useradd`/`userdel`/`usermod`/`groupadd`/`groupdel`/`groupmod`;
- privilege configuration: `visudo`, `vipw`, `vigr`, and writes to `/etc/passwd`, `/etc/shadow`, `/etc/group`, `/etc/gshadow`, `/etc/master.passwd`, `/etc/sudoers`, or `/etc/sudoers.d/` through `tee`, `cp`, `mv`, `install`, `ln`, `truncate`, `rm`, `unlink`, `sed -i`, `perl -i`, or a redirection;
- macOS: `dscl` with `-create`, `-delete`, `-passwd`, `-append`, or `-merge`; `sysadminctl` with `-addUser`, `-deleteUser`, `-resetPasswordFor`, `-secureTokenOn`, `-secureTokenOff`, or `-adminUser`; `dseditgroup -o create|delete|edit`;
- Windows: `net user` or `net localgroup` with `/add` or `/delete`, and the `New-`, `Remove-`, `Set-`, `Add-`, `Rename-`, `Enable-`, and `Disable-` `LocalUser`, `LocalGroup`, and `LocalGroupMember` cmdlets.

A command the parser stops at (an unterminated quote, nesting deeper than 3, more than 256 KiB) is blocked as uninspectable, and so is a write whose target, known only at run time, can name an account file (`echo x > "$F"`). A Unix account command is refused whatever its arguments.

A program the command runs but does not contain (`bash -c "$CMD"`, `curl … | sh`, `eval "$(tool)"`, `python3 -c "$CODE"`) is judged by shell-command-guard; this hook refuses one only when its text names `useradd`, `adduser`, `userdel`, `deluser`, `usermod`, `groupadd` and similar phrases.

## Refusals and limits

- The hook does not create, delete, rename, lock, unlock, or modify accounts or groups.
- It does not read, generate, set, expose, or rotate passwords and authentication material.
- It does not inspect directory services, cloud identity systems, custom wrappers, or remote machines.
- On Claude Code it is bound to the `Bash` tool only; commands run through the `PowerShell` tool on Windows are not inspected.
- It does not infer authorization from an account name, prompt, environment variable, or CLI flag.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add user-account-mutation-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives (hook-design 4.3), each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
