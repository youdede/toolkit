# Firewall policy mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit rule, chain, policy, activation, and flush mutations through common Linux, macOS, and Windows host-firewall tools: `iptables`/`ip6tables` (including the `-nft` and `-legacy` names and `*-restore`), `nft`, `ufw`, `firewall-cmd`, `pfctl`, the macOS application firewall `socketfilterfw`, `netsh advfirewall` and `netsh firewall`, and the `*-NetFirewall*` PowerShell cmdlets. Listing and status commands pass. Commands are read through the shared item parser, so wrappers such as `sudo --`, `env`, `timeout`, `xargs`, and static `sh -c`/`eval` are unwrapped. Its pure `evaluate(input)` function neither reads nor changes host networking state.

A program the command runs but does not contain (`bash -c "$CMD"`, `curl … | sh`, `eval "$(tool)"`, `python3 -c "$CODE"`) is judged by shell-command-guard; this hook refuses one only when its text names `iptables`, `ip6tables`, `nft add`, `nft delete`, `nft flush`, `ufw allow` and similar phrases.

## Refusals and limits

- The hook does not add, remove, replace, flush, enable, or disable firewall policy.
- It does not determine whether a port, address, interface, zone, or rule is trustworthy.
- It does not inspect cloud firewalls, service meshes, routers, custom wrappers, or remote systems.
- It does not replace network isolation, least privilege, or operating-system enforcement.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add firewall-policy-mutation-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives, each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
