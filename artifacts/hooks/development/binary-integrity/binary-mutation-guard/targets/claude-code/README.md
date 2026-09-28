# binary-mutation-guard

Reads only a bounded prefix without following symlinks, recognizes NUL and common binary signatures, and prevents text Write or Edit tools from corrupting those files. A target that does not exist yet is allowed. An existing target outside the project root (`CLAUDE_PROJECT_DIR`, or the payload cwd when it is unset), behind a symlink, or unreadable is blocked as unverified.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not block normal binary-producing build commands.
- It does not classify UTF-16 text or JSON notebooks as binary solely by extension.
- It does not repair, convert, or inspect full binary contents.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
