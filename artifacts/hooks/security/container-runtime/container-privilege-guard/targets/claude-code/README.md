# Container privilege guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit host privilege expansion in Docker or Podman commands and recognized Docker Compose, Kubernetes, deployment, chart, and Helm configuration. It covers privileged mode, host namespaces (`--pid`, `--ipc`, `--network`/`--net`, `--uts`, `--userns`, `--cgroupns` set to `host`, with `=` or a separate value; Compose `network_mode`, `pid`, `ipc`, `uts`, `userns_mode`; Kubernetes `hostPID`, `hostIPC`, `hostNetwork`), selected dangerous capabilities including `ALL`, the container-engine socket, and device passthrough, for `run`, `create`, `container run`, and `container create`. Commands are read through the shared item parser; an option value known only at run time blocks as uninspectable where it can spell the risk (`--network "$NET"`, `-v "$SRC":/app`), and so does a word that can spell a privileged option.

The exported pure `evaluate(input)` function analyzes only the command or proposed content. Configuration checks intentionally run only on recognizable container paths to avoid treating ordinary prose or fixtures as deployment policy.

A program the command runs but does not contain (`bash -c "$CMD"`, `curl … | sh`, `eval "$(tool)"`, `python3 -c "$CODE"`) is judged by shell-command-guard; this hook refuses one only when its text names `--privileged`, `docker.sock`, `--cap-add`, `--pid=host`, `--network=host`.

## Refusals and limits

- The hook does not run, inspect, stop, or reconfigure containers or clusters.
- It does not validate every admission, seccomp, AppArmor, SELinux, or pod-security rule.
- It does not infer privileges hidden in templates, variables, custom tooling, or remote manifests.
- It does not accept annotations, comments, or environment variables as approval.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add container-privilege-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives (hook-design 4.3), each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
