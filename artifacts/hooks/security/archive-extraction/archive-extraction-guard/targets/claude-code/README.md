# Archive extraction guard for Claude Code

This project-scoped `PreToolUse` hook allows archive listing and integrity checks but blocks actual TAR, ZIP, and 7-Zip extraction from Bash. The conservative boundary is intentional: the standalone hook has no external archive parser, so it cannot prove that every entry, link target, and expansion size stays inside the destination before the extraction tool runs.

The policy core is the exported pure `evaluate(input)` function. It reads each command through the shared item parser, so wrappers (`sudo`, `env`, `nice`, `timeout`, `xargs`), static `sh -c`/`bash -c`/`eval`, `find -exec`, and subshells are unwrapped, and it recognizes tar's dashless flag word (`tar xf`). A word known only at run time blocks as uninspectable where it can spell an extraction (`tar "$FLAGS" a.tar`); a dynamic executable does so only next to an extraction flag and an archive name (tar) or a zip-format archive name (unzip). Input is bounded, and diagnostics never include submitted command text.

A program the command runs but does not contain (`bash -c "$CMD"`, `curl … | sh`, `eval "$(tool)"`, `python3 -c "$CODE"`) is judged by shell-command-guard; this hook refuses one only when its text names `tar x`, `tar -x`, `unzip`, `7z x`, `bsdtar`.

## Refusals and limits

- The hook does not extract, rewrite, repair, quarantine, or delete archives.
- It does not claim that listing filenames proves link containment or decompression safety.
- It does not inspect proprietary archive formats or encrypted archive contents.
- It does not accept comments, flags, prompts, or environment variables as approval.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add archive-extraction-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives, each refused on purpose:

- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
