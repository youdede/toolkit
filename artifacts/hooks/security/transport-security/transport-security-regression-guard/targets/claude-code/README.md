# Transport security regression guard for Claude Code

This project-scoped `PreToolUse` hook inspects bounded proposed content and blocks explicit certificate-verification disablement in common Node.js, Go, Python, and cURL-style settings, npm and Yarn `strict-ssl=false`/`enableStrictSsl: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0` (quoted or bare, in code, `.env` files, `export` lines, Dockerfile `ENV`, and YAML lists), a quoted `"rejectUnauthorized": false` key (JSON), plus non-local HTTP registry configuration (`registry=http://...` in `.npmrc`). Comments are masked before matching, and localhost HTTP remains permitted.

The exported `evaluate(input)` policy is pure. The Claude Code entrypoint reads only the target file (up to 512 KiB) to compare its current and proposed content; it does not read the rest of the repository or infer runtime topology. A relative path resolves against `CLAUDE_PROJECT_DIR`, else the hook input `cwd`. Inside that directory no path component may be a symbolic link. A file outside it is not project configuration, but its proposed content is still checked; a symbolic link there is not read and the change is blocked.

## Refusals and limits

- The hook does not prove that a TLS configuration or certificate chain is otherwise secure.
- It does not rewrite endpoints, generate certificates, or change trust stores.
- It does not interpret dynamic configuration, custom wrappers, or every framework option.
- It does not accept inline comments or project files as approval to disable verification.
