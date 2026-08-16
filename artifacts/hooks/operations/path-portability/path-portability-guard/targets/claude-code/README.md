# Path portability guard for Claude Code

This hook checks path components before a native file mutation. It applies a conservative common-filesystem subset and compares the target basename with bounded sibling names.

Portable relative in-repository names and edits to the exact existing path remain allowed. Unicode is compared in normalized form for sibling collisions.

The check does not cover every filesystem. It has no project-defined ignore file or inline exception.

## Refusals

- It does not rename, move, delete, normalize, transliterate, or create a requested path.
- It does not guarantee portability to every filesystem, archive format, or deployment target.
- It does not follow project-defined ignore files or inline exceptions authored by the agent.
- It does not inspect file content or infer whether a portability issue is intentional.
