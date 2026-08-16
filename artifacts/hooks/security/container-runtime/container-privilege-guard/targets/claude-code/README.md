# Container privilege guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit host privilege expansion in Docker or Podman commands and recognized Docker Compose, Kubernetes, deployment, chart, and Helm configuration. It covers privileged mode, host namespaces, selected dangerous capabilities, the container-engine socket, and device passthrough.

The exported pure `evaluate(input)` function analyzes only the command or proposed content. Configuration checks intentionally run only on recognizable container paths to avoid treating ordinary prose or fixtures as deployment policy.

## Refusals and limits

- The hook does not run, inspect, stop, or reconfigure containers or clusters.
- It does not validate every admission, seccomp, AppArmor, SELinux, or pod-security rule.
- It does not infer privileges hidden in templates, variables, custom tooling, or remote manifests.
- It does not accept annotations, comments, or environment variables as approval.
