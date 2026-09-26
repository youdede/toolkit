# foreground-process-guard

Classifies bounded static shell commands and stops common servers, watchers, and follow-mode tools unless a timeout, detached session, or explicit background boundary is present.

Recognized: `npm`, `pnpm`, `yarn`, or `bun` scripts named exactly `dev`, `start`, `serve`, or `watch`; `vite` without `build`; `next dev`/`start`; `webpack serve`; watch modes of `rollup` and `tsc`; `nodemon`, `watchexec`, `entr`, `tail -f`, `journalctl -f`; `python -m http.server`, `rails server`, `uvicorn`, `gunicorn`, `flask run`, `manage.py runserver`, `php artisan serve`, `cargo watch`, `ng serve`, `hugo server`, `jekyll serve`; `node server.js` and `go run` of a path containing `server`; `docker compose up` without `-d`; `kubectl port-forward`. A trailing `&`, `timeout`, a detached `tmux` or `screen` session, `systemd-run`, and Claude Code's `run_in_background` count as boundaries. Commands are read through the shared shell analysis, so a server inside `bash -c`, `eval`, or after `cd … &&` is seen.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not kill existing processes or manage process supervisors.
- It does not block bounded one-shot build and test commands.
- It does not execute dynamic shell content to discover its duration.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
