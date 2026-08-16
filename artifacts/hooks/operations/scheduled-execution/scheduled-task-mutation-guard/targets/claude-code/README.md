# Scheduled task mutation guard for Claude Code

This project-scoped `PreToolUse` hook blocks explicit task creation, alteration, execution, and deletion through cron, `at`, launchd, and Windows Task Scheduler. Read-only listing operations remain allowed. The exported `evaluate(input)` function has no side effects.

## Refusals and limits

- The hook does not create, run, edit, export, import, or delete scheduled tasks.
- It does not inspect existing scheduler databases, task XML, or launchd property lists.
- It does not recognize custom wrappers, aliases, APIs, or remote scheduler systems.
- It does not infer human approval from a task name, comment, prompt, or flag.
