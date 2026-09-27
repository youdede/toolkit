# Package publish guard for Claude Code

This project-scoped `PreToolUse` hook blocks real package publication through npm, pnpm, Bun, Yarn (`yarn publish` and `yarn npm publish`), Twine (also `python -m twine upload`), Poetry, uv, Hatch, Flit, Cargo, RubyGems, dotnet, and NuGet. Local build, pack, check, and supported dry-run forms remain allowed. The exported `evaluate(input)` function performs no network or credential access.

## Refusals and limits

- The hook does not build, sign, tag, publish, yank, deprecate, or upload packages.
- It does not inspect registry credentials, ownership, provenance, or access policy.
- It does not recognize custom release wrappers, aliases, API calls, or every ecosystem client.
- It reads each command through the shared shell analysis: wrappers such as `sudo`, `doas`, `env`, `nice`, and `timeout`, `sh -c`/`bash -c`/`eval`, `xargs`, `find -exec`, and interpreter one-liners (`python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `deno eval`, also attached as `-c"…"` or `--eval=…`). If the program names something that can run a command (a module such as `subprocess` or `child_process`, a call such as `system`, backticks, or a dynamic name such as `getattr` or `eval`), the hook treats it as uninspectable and blocks it when the text, or the program's string literals joined, concerns what the hook protects; a static command in a literal gets its concrete rule. A command built at run time from pieces that do not name it is not seen. A program that names nothing of the kind passes, and its literals are data. A program the reader does not follow to the end (more than 256 literals, deep interpolation, an unterminated literal) is uninspectable too. A one-liner whose program is known only at run time counts as a form the analysis cannot follow. It does not see a command built at run time, a command inside `$(…)`, a script file, or a program that passes an argument list. A shell form the analysis cannot follow is refused only when the command text looks like a publication (`publish`, `upload`, `gem push`, `nuget push`).
- It does not accept OTP values, confirmation flags, comments, or prompt text as authorization.
