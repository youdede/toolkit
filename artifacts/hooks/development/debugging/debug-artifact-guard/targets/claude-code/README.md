# Debug artifact guard for Claude Code

The hook inspects Git's staged blobs immediately before `git commit`. It reports file paths, line numbers, and stable rule IDs, but never prints the matching source line.

Inspection is tied to the active worktree. A commit command that first uses `cd`/`pushd`, `git -C`, `--git-dir`, or `--work-tree` is blocked as an unverifiable scope; run the hook from the intended worktree instead.

The narrow default rules cover:

- unresolved `<<<<<<<`, `=======`, and `>>>>>>>` merge-conflict markers in every bounded staged non-binary blob, including Markdown and plain text;
- standalone JavaScript/TypeScript `debugger;`, Python `breakpoint()` or `pdb.set_trace()`, Ruby `binding.pry`/`byebug`, and PHP `xdebug_break()` statements;
- `.only` JavaScript/TypeScript tests in test-like paths and focused RSpec examples in `_spec.rb` files.

Ordinary `console.log`, `print`, TODO comments, skipped tests, and `.only` methods in non-test source are outside the policy. Secret scanning remains the separate responsibility of `commit-guard`.

The installed guard exposes no project-writable allowlist, inline suppression, environment bypass, or runtime approval. Relevant staged text/source files larger than 2 MiB are blocked with `debug-file-too-large` because they cannot be scanned within the bound. Any exceptional commit must be performed by a person outside the guarded agent session or after that person explicitly disables the exact hook entry.

## Refusals and limits

- The hook does not scan for secrets, dependencies, lint failures, ordinary logging, TODOs, or skipped tests.
- It does not remove findings, resolve conflicts, rewrite staged blobs, or mutate the Git index.
- It does not scan repository history, untracked files, unstaged content, or binary files; language-specific debugger rules remain limited to supported source formats.
- It does not accept inline suppression comments or expose an agent-writable exception policy.
- It does not claim that absence of these bounded patterns proves production readiness.
