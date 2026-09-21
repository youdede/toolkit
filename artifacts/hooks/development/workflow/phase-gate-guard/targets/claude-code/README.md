# phase-gate-guard

Owns one boundary: the `.youdede/phases/` evidence chain `spec → design → tasks → implementation`. A phase evidence file may only be written when its predecessor exists and is a valid evidence object (matching phase, summary of at least 20 characters, non-empty anchors). Unknown filenames in the reserved directory, malformed evidence, and unreadable predecessors are blocked.

The hook is deterministic, reads at most 1 MiB from stdin and 64 KiB per evidence file, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not judge the quality of a spec, design, task list, or implementation note — only the presence and validity of predecessor evidence.
- It does not inspect, block, or observe any write outside the reserved `.youdede/phases/` directory.
- It does not execute submitted content, call an LLM, download anything, or transmit inspected data.
- It does not treat an unreadable, symlinked, or oversized predecessor as valid evidence.
