# Firewall policy mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit rule, chain, policy, activation, and flush mutations through common Linux, macOS, and Windows host-firewall tools: `iptables`/`ip6tables` (including the `-nft` and `-legacy` names and `*-restore`), `nft`, `ufw`, `firewall-cmd`, `pfctl`, the macOS application firewall `socketfilterfw`, `netsh advfirewall` and `netsh firewall`, and the `*-NetFirewall*` PowerShell cmdlets. Listing and status commands pass. Commands are read through the shared shell analysis, so wrappers such as `sudo --`, `env`, `timeout`, `xargs`, and static `sh -c`/`eval` are unwrapped. Its pure `evaluate(input)` function neither reads nor changes host networking state.

## Refusals and limits

- The hook does not add, remove, replace, flush, enable, or disable firewall policy.
- It does not determine whether a port, address, interface, zone, or rule is trustworthy.
- It does not inspect cloud firewalls, service meshes, routers, custom wrappers, or remote systems.
- It does not replace network isolation, least privilege, or operating-system enforcement.
