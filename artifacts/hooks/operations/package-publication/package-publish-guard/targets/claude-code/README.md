# Package publish guard for Claude Code

This project-scoped `PreToolUse` hook blocks real package publication through npm, pnpm, Bun, Yarn (`yarn publish` and `yarn npm publish`), Twine (also `python -m twine upload`), Poetry, uv, Hatch, Flit, Cargo, RubyGems, dotnet, and NuGet. Local build, pack, check, and supported dry-run forms remain allowed. The exported `evaluate(input)` function performs no network or credential access.

## Refusals and limits

- The hook does not build, sign, tag, publish, yank, deprecate, or upload packages.
- It does not inspect registry credentials, ownership, provenance, or access policy.
- It does not recognize custom release wrappers, aliases, API calls, or every ecosystem client.
- It reads each command through the shared shell analysis: wrappers such as `sudo`, `doas`, `env`, `nice`, and `timeout`, `sh -c`/`bash -c`/`eval`, `xargs`, `find -exec`, and the string literals of interpreter one-liners (`python -c`, `node -e`, `pwsh -c`). It does not see a command built at run time, a command inside `$(…)`, a script file, or a program that passes an argument list. A shell form the analysis cannot follow is refused only when the command text looks like a publication (`publish`, `upload`, `gem push`, `nuget push`).
- It does not accept OTP values, confirmation flags, comments, or prompt text as authorization.
