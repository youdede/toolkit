# Dynamic code execution guard for Claude Code

This project-scoped `PreToolUse` hook blocks direct eval-style primitives introduced in supported JavaScript, TypeScript, Python, PHP, and Ruby edits. A bounded lexical pass masks comments and string literals before language-specific rules run, reducing documentation and fixture false positives.

The exported `evaluate(input, context)` function is pure. The entrypoint reads the current file (bounded) and reconstructs the complete proposed content, so only newly introduced primitives block. Files without a supported extension are not read at all, and the project root is `CLAUDE_PROJECT_DIR` before the hook's `cwd`. Python and Ruby code is not masked for `//` or `/* */`, which are not comments there.

## Refusals and limits

- The hook does not execute, parse, format, or repair submitted programs.
- It does not claim to detect custom wrappers, reflection, interpreters, or indirect data flows.
- It does not decide whether a direct dynamic execution call is safe in context.
- It does not accept comments, environment flags, or project allowlists as approval.
