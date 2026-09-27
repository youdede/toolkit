# Container registry publish guard for Claude Code

This project-scoped `PreToolUse` hook blocks image and artifact pushes through Docker, Podman, Compose, buildx, ORAS, and Helm: `push`, `compose push`, `manifest push`, builds with `--push` or an output of `type=registry` or `push=true`, and `buildx imagetools create`. Local builds, loads, inspections, scans, saves, and chart packaging remain allowed. The pure `evaluate(input)` policy does not contact registries or read credentials.

## Refusals and limits

- The hook does not build, push, sign, copy, promote, or remove registry artifacts.
- It does not inspect registry credentials, repository ownership, tags, provenance, or retention rules.
- It does not recognize custom wrappers, aliases, SDK calls, or every OCI client.
- It reads each command through the shared shell analysis: wrappers such as `sudo`, `doas`, `env`, `nice`, and `timeout`, `sh -c`/`bash -c`/`eval`, `xargs`, `find -exec`, and the string literals of interpreter one-liners (`python -c`, `node -e`, `pwsh -c`, also attached as `-c"…"` or `--eval=…`) when the program's code, outside its literals and comments, names something that can run a command (a module such as `subprocess` or `child_process`, a call such as `system`, backticks, or a dynamic name such as `getattr` or `eval`); otherwise the literals are data and the command passes. With such a name every literal counts as a command, even one the program only prints, and a program the reader cannot follow to the end (more than 256 literals, a here-document, a dynamic name) counts as a form the analysis cannot follow. A one-liner whose program is known only at run time counts as a form the analysis cannot follow. It does not see a command built at run time, a command inside `$(…)`, a script file, or a program that passes an argument list. A shell form the analysis cannot follow is refused only when the command text looks like a registry push.
- It does not infer approval from an image tag, registry hostname, command flag, or prompt.
