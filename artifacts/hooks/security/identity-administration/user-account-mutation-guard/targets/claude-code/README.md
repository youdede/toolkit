# User account mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit local user, group, password, and privilege-assignment changes through common Unix, macOS, and Windows account tools. Read-only identity commands remain allowed. The exported `evaluate(input)` policy is pure and does not inspect account databases.

The hook reads the Bash command with the shared Youdede shell analysis, so it sees each command behind `&&`, `||`, `;`, pipes, subshells, `sudo`, `doas`, `env`, `nice`, `timeout`, `setsid`, `exec`, `xargs`, `find -exec`, `sh -c`, `bash -c`, `eval`, and `pwsh -Command`. It blocks:

- Unix: `useradd`, `adduser`, `userdel`, `deluser`, `usermod`, `groupadd`, `addgroup`, `groupdel`, `delgroup`, `groupmod`, `gpasswd`, `chpasswd`, `passwd`, `newusers`, `chage`, and `pw useradd`/`userdel`/`usermod`/`groupadd`/`groupdel`/`groupmod`;
- privilege configuration: `visudo`, `vipw`, `vigr`, and writes to `/etc/passwd`, `/etc/shadow`, `/etc/group`, `/etc/gshadow`, `/etc/master.passwd`, `/etc/sudoers`, or `/etc/sudoers.d/` through `tee`, `cp`, `mv`, `install`, `ln`, `truncate`, `rm`, `unlink`, `sed -i`, `perl -i`, or a redirection;
- macOS: `dscl` with `-create`, `-delete`, `-passwd`, `-append`, or `-merge`; `sysadminctl` with `-addUser`, `-deleteUser`, `-resetPasswordFor`, `-secureTokenOn`, `-secureTokenOff`, or `-adminUser`; `dseditgroup -o create|delete|edit`;
- Windows: `net user` or `net localgroup` with `/add` or `/delete`, and the `New-`, `Remove-`, `Set-`, `Add-`, `Rename-`, `Enable-`, and `Disable-` `LocalUser`, `LocalGroup`, and `LocalGroupMember` cmdlets.

A command the analysis cannot normalize (a dynamic executable, `bash -c "$SCRIPT"`, an unterminated quote) is blocked as uninspectable, and so is a Unix account command with a dynamic argument.

## Refusals and limits

- The hook does not create, delete, rename, lock, unlock, or modify accounts or groups.
- It does not read, generate, set, expose, or rotate passwords and authentication material.
- It does not inspect directory services, cloud identity systems, custom wrappers, or remote machines.
- On Claude Code it is bound to the `Bash` tool only; commands run through the `PowerShell` tool on Windows are not inspected.
- It does not infer authorization from an account name, prompt, environment variable, or CLI flag.
