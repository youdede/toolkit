# Container registry publish guard for Claude Code

This project-scoped `PreToolUse` hook blocks image and artifact pushes through Docker, Podman, buildx, ORAS, and Helm. Local builds, loads, inspections, scans, saves, and chart packaging remain allowed. The pure `evaluate(input)` policy does not contact registries or read credentials.

## Refusals and limits

- The hook does not build, push, sign, copy, promote, or remove registry artifacts.
- It does not inspect registry credentials, repository ownership, tags, provenance, or retention rules.
- It does not recognize custom wrappers, aliases, SDK calls, or every OCI client.
- It does not infer approval from an image tag, registry hostname, command flag, or prompt.
