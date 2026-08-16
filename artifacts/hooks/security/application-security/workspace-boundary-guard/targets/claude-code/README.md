# Workspace boundary guard for Claude Code

This project-scoped `PreToolUse` hook inspects native `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` targets before they run. It first requires the lexical target to remain under the project root, then resolves the nearest existing ancestor and requires its canonical location to remain under the canonical project root. The second check catches both existing symlink targets and not-yet-created paths beneath a symlinked directory.

The hook uses `CLAUDE_PROJECT_DIR` when available and otherwise uses the structured input `cwd`. It reads filesystem metadata only, caps input and path sizes, and emits stable rule identifiers without printing the attempted absolute path. Missing, malformed, oversized, or uninspectable targets fail closed.

## Refusals and limits

- The hook does not accept a project file, tool field, comment, or environment toggle as a bypass.
- It does not rewrite a path, create a directory, follow an escaping symlink, or approve an edit.
- It does not inspect Bash, MCP, or third-party file tools; their path contracts require separate adapters.
- It does not detect hard-link aliases or eliminate the filesystem race between inspection and the native tool operation.
- It is defense in depth, not an operating-system sandbox or proof that an allowed edit is safe.

Examples it refuses include `../outside.txt`, an absolute path outside the project, and `inside-link/new.txt` when `inside-link` resolves to an external directory. A normal file, a missing child beneath an ordinary in-workspace directory, and a symlink whose canonical target remains inside the workspace pass this boundary.
