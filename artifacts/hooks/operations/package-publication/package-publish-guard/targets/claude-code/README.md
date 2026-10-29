# Package publish guard for Claude Code

This project-scoped `PreToolUse` hook blocks real package publication through npm, pnpm, Bun, Yarn (`yarn publish` and `yarn npm publish`), Twine (also `python -m twine upload`), Poetry, uv, Hatch, Flit, Cargo, RubyGems, dotnet, and NuGet. npm runs a command from any unique abbreviation, so `npm pu`, `npm pub`, `npm publ`, `npm publi`, and `npm publis` are publications too; pnpm and Yarn 1 do not abbreviate. The command a package runner starts is judged as well: `npx npm publish`, `npx npm@10 publish`, `npm exec -- npm publish`, `pnpm dlx npm publish`, `poetry run twine upload`, `bundle exec gem push`. Local build, pack, check, and supported dry-run forms remain allowed. The exported `evaluate(input)` function performs no network or credential access.

## Refusals and limits

- The hook does not build, sign, tag, publish, yank, deprecate, or upload packages.
- It does not inspect registry credentials, ownership, provenance, or access policy.
- It does not recognize custom release wrappers, aliases, API calls, or every ecosystem client.
- It reads each command with the shared shell item parser and capability matcher: wrappers such as `sudo`, `doas`, `env`, `nice`, `timeout`, `xargs`, and `find -exec`; static `sh -c`, `eval`, here-documents, and `echo`/`printf` feeds into a shell; functions defined and called in the same command; and the options that take a value, so the verb is found wherever it sits. A word that may expand to a protected verb, or a command the parser stops at (nesting deeper than 3, more than 256 KiB, unbalanced syntax), is uninspectable. Interpreter one-liners (`python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `deno eval`) are read when the program can run a command (a module such as `subprocess` or `child_process`, a call such as `system`, backticks, or `eval`): if its text or one of its string literals, joined and with escapes decoded, concerns what the hook protects, the command is uninspectable, never the concrete rule, because the program may not run it. Such a program that only prints the command is refused too (a retained false positive). A program that names nothing of the kind passes, and a command built at run time from pieces that do not name it is not seen. An opaque executable (`$"x" …`) is uninspectable.
- It does not accept OTP values, confirmation flags, comments, or prompt text as authorization.
- Programs the command runs but does not contain (`curl … | sh`, `eval "$X"`, `bash -c "$CMD"`) are refused by shell-command-guard, installed as a prerequisite. Local script files (`bash script.sh`) and shell setup output (`eval "$(pyenv init -)"`, `source <(kubectl completion bash)`) are not inspected.

Retained false positives, each refused on purpose:

- `yarn publish --dry-run`, `hatch publish --dry-run`, and `flit publish --dry-run` are refused: their dry runs are not verified.
- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
- An option the hook has not verified, before a safe option (`npm publish --unknown --dry-run`), is read both ways, so the safe mode does not count; verifying the option into the CLI fixture fixes it.
