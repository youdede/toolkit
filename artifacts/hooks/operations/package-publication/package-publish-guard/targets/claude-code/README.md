# Package publish guard for Claude Code

This project-scoped `PreToolUse` hook blocks real package publication through npm, pnpm, Yarn, Twine, Poetry, Cargo, RubyGems, dotnet, and NuGet. Local build, pack, check, and supported dry-run forms remain allowed. The exported `evaluate(input)` function performs no network or credential access.

## Refusals and limits

- The hook does not build, sign, tag, publish, yank, deprecate, or upload packages.
- It does not inspect registry credentials, ownership, provenance, or access policy.
- It does not recognize custom release wrappers, aliases, API calls, or every ecosystem client.
- It does not accept OTP values, confirmation flags, comments, or prompt text as authorization.
