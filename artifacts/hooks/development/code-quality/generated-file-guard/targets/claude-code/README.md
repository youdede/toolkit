# Generated file guard for Claude Code

The hook runs before Write or Edit. It blocks a target only when at least one high-confidence signal is present:

- an explicit generated-file header in the existing or proposed content;
- a narrow filename convention such as `*.generated.ts`, `*.gen.go`, `*.g.dart`, `*_pb2.py`, or `*.designer.cs`;
- a framework-owned output directory such as `.next`, `.nuxt`, or `.svelte-kit`;

Broad names such as `build`, `dist`, and `generated` are deliberately not classified on their own. The hook reads at most the first 64 KiB of an existing regular file. It never follows a symlink while looking for a marker and blocks direct Write/Edit against an existing symlink so the link cannot bypass inspection or redirect a write outside the project. A path whose nearest existing parent directory resolves outside the project, through a symlinked directory, is blocked with `generated-inspection-failed` and nothing behind it is read.

The installed hook has no runtime allowlist or project-writable policy file: an agent able to invoke Bash could otherwise author its own exception. A person who intentionally needs to edit a generated output must disable or remove the exact hook entry outside the guarded agent session, perform the reviewed operation, and restore the guard.

## Refusals and limits

- The hook does not regenerate, repair, or locate the source template for a generated file.
- It does not infer that every file in a broadly named `build`, `dist`, or `generated` directory is generated.
- It does not follow symlinks or inspect files outside the active project root; direct edits to an existing symlink are blocked.
- It does not provide an inline comment, path allowlist, environment variable, or project file that bypasses a finding.
- It does not claim to recognize every generator-specific marker or naming convention.
