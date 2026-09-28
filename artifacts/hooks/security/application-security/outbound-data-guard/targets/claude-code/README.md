# Outbound data guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit local-to-remote data movement in Bash and PowerShell commands. Its reusable `evaluate(input, context)` policy core is deterministic, side-effect free, and independent of Claude Code; the included adapter only translates the hook event and process exit code.

The bounded analyzer covers file and standard-input uploads in curl, wget, HTTPie, PowerShell web commands, netcat-style streams, SSH streams, SCP, rsync, SFTP batch mode, rclone, and common AWS, Google Cloud, Azure, and Kubernetes transfer commands. It allows ordinary HTTP GETs, static request bodies, downloads, remote-to-local copies, and local-only pipelines. Dynamic values are blocked only when they occupy an explicit outbound payload, upload source, or protected transfer position.

Commands are read with the shared item parser, so the hook sees each command behind `&&`, `||`, `;`, pipes, subshells, `sudo`, `doas`, `env`, `nice`, `timeout`, `setsid`, `exec`, `sh -c`, `bash -c`, `eval`, and `pwsh -Command`, and the commands that `xargs` and `find -exec` run. curl short options can be grouped (`curl -sT file`, `curl -sd @file`). A word that `xargs` or `find -exec` supplies at run time, and an unquoted glob, count as dynamic values.

The hook never opens local files, performs DNS or network calls, or prints command text, URLs, destinations, paths, headers, or payloads. Malformed and oversized hook input fails closed, and so does an event with neither a tool name nor a command (empty input or `{}`); events for other tools fail open.

A program the command runs but does not contain (`bash -c "$CMD"`, `curl … | sh`, `eval "$(tool)"`, `python3 -c "$CODE"`) is judged by shell-command-guard; this hook refuses one only when its text names `--upload-file`, `curl -T`, `--data-binary @`, `--post-file`, `rclone copy`, `aws s3 cp` and similar phrases.

## Refusals and limits

- The hook refuses to inspect, print, upload, redact, retain, or summarize local file contents and payload values.
- It refuses project-controlled allowlists, environment-variable bypasses, and instructions for evading a matched rule.
- It refuses to claim complete data-loss prevention, protocol coverage, process confinement, or network isolation.
- It does not inspect network behavior hidden inside arbitrary programs, package scripts, containers, browser automation, or later child processes.
- A non-match is not approval and does not establish that a command or destination is trustworthy.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add outbound-data-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives (hook-design 4.3), each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.

Installation and removal are one-command, marker-scoped toolkit operations. The packaged runtime has no third-party dependency.
