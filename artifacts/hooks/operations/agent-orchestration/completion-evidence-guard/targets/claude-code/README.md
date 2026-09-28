# completion-evidence-guard

Install with `npx @youdede/toolkit add completion-evidence-guard`. Add `[youdede:evidence-required]` to a task description or specialist brief to activate the gate. A passing task receipt must use `[youdede:evidence status=pass task=<task-id>]`; a specialist receipt omits `task`. Both require bounded `Source:` and `Result: pass` lines.

The hook reads at most 4 MiB of a regular, non-symlink transcript. A task opts in through its description only, so an unmarked task never needs the transcript; a specialist opts in through its brief, the latest user message, or the prompt of the `Agent` call that started it. It blocks an opted-in completion when evidence is absent, mismatched, oversized, or uninspectable, and a specialist completion whose transcript cannot be read. Unmarked work is allowed.

## Refusals and limits

- It does not activate for work without the exact evidence-required marker.
- It does not run verification commands or prove that a reported result is truthful.
- It does not accept a receipt tied to another task identifier.
- It does not edit task state, transcripts, agent definitions, or final output.
