# Test integrity guard for Claude Code

The hook runs before Bash, Write, Edit, or MultiEdit. For recognized test-source paths, it reconstructs the complete proposed file within a 512 KiB bound, masks comments and strings where practical, and blocks net-new or relocated unconditional skip, expected-failure, or ignore markers. MultiEdit is refused when its complete result cannot be reconstructed; existing suppressions do not freeze unrelated edits.

The scanner covers common JavaScript/TypeScript, Python, Ruby, Rust, Java/Kotlin, C#, PHP, Go, and Swift test markers. Focused tests such as `.only`, `fit`, and `fdescribe` are deliberately outside this hook because `debug-artifact-guard` already owns that boundary.

For Bash, the hook performs bounded static shell tokenization. It blocks explicit `rm`, `unlink`, `git rm`, `find ... -delete`, and rename-away operations when a test source is statically identifiable. A rename remains allowed when the destination is still a recognizable test path. Ordinary edits, test execution, Git inspection, temporary-file cleanup, documentation text, and commands that merely quote an example are allowed.

Relevant missing, ambiguous, oversized, out-of-root, or symlinked file edits fail closed. The installed hook has no runtime allowlist, inline suppression, environment bypass, or project-authored approval file.

## Refusals and limits

- The hook does not run tests, measure coverage, repair a test, or decide whether a suppression is justified.
- It does not inspect focused-test markers, because those belong to `debug-artifact-guard`.
- It does not claim to detect deletion performed by arbitrary interpreters, build tools, unknown commands, dynamic paths, MCP tools, or application code.
- It does not rewrite files, mutate the Git index, or recover a removed test.
- It does not claim that the absence of a matched suppression proves adequate test coverage.
