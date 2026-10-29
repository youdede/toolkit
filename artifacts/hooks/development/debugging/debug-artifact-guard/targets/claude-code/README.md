# Debug artifact guard for Claude Code

The hook inspects Git's staged blobs immediately before `git commit`. When the commit takes content from the working tree (`git add X && git commit`, `git commit -a`, or a pathspec), it also reads the modified and untracked working-tree files the commit can include. `xargs`, `find -exec`, `sh -c`, and `eval` are followed to the commit they run. Configured Git aliases are followed one level (read with `git config --get-regexp` only for a subcommand that is not built in). A commit in the same command as `git add -f`, an alias definition (`git config alias.<name>`, `git -c alias.<name>=…`), a shell alias (`!…`), or an alias of an alias is refused as `debug-commit-scope-unsupported`: run them as separate tool calls. A program the command runs but does not contain (`bash -c "$X"`, `curl … | sh`) is left to shell-command-guard. It reports file paths, line numbers, and stable rule IDs, but never prints the matching source line.

Inspection is tied to the active worktree. A commit command that first uses `cd`/`pushd`, `git -C`, `--git-dir`, or `--work-tree` is blocked as an unverifiable scope; run the hook from the intended worktree instead.

The narrow default rules cover:

- unresolved `<<<<<<<` and `>>>>>>>` merge-conflict markers in every bounded non-binary blob, including Markdown and plain text, and `=======` when the same blob also has the other two (alone it is a Markdown heading underline);
- standalone JavaScript/TypeScript `debugger;`, Python `breakpoint()` or `pdb.set_trace()`, Ruby `binding.pry`/`byebug`, and PHP `xdebug_break()` statements;
- `.only` JavaScript/TypeScript tests (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.vue`) in test-like paths and focused RSpec examples in `_spec.rb` files.

Ordinary `console.log`, `print`, TODO comments, skipped tests, and `.only` methods in non-test source are outside the policy. Secret scanning remains the separate responsibility of `commit-guard`.

The installed guard exposes no project-writable allowlist, inline suppression, environment bypass, or runtime approval. Relevant staged text/source files larger than 2 MiB are blocked with `debug-file-too-large` because they cannot be scanned within the bound. Any exceptional commit must be performed by a person outside the guarded agent session or after that person explicitly disables the exact hook entry.

## Refusals and limits

- The hook does not scan for secrets, dependencies, lint failures, ordinary logging, TODOs, or skipped tests.
- It does not remove findings, resolve conflicts, rewrite staged blobs, or mutate the Git index.
- It does not scan repository history or binary files, or working-tree content that the commit does not take; language-specific debugger rules remain limited to supported source formats.
- It does not accept inline suppression comments or expose an agent-writable exception policy.
- It does not claim that absence of these bounded patterns proves production readiness.
- It reads the files the commit takes before the Bash command runs, not after. Another command earlier in the same command line is not executed by the hook, so its effect is not seen: `echo 'debugger;' >> app.js && git commit -am x` adds the debugger statement after the check. Run the change and the commit as separate tool calls so the commit is checked against the changed state.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add debug-artifact-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives, each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
