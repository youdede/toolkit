# Transport security regression guard for Claude Code

This project-scoped `PreToolUse` hook inspects bounded proposed content and blocks explicit certificate-verification disablement in common Node.js, Go, Python, and cURL-style settings, plus non-local HTTP registry configuration. Comments are masked before matching, and localhost HTTP remains permitted.

The exported `evaluate(input)` policy is pure. It analyzes only content present in the tool request; it does not read the repository or infer runtime topology.

## Refusals and limits

- The hook does not prove that a TLS configuration or certificate chain is otherwise secure.
- It does not rewrite endpoints, generate certificates, or change trust stores.
- It does not interpret dynamic configuration, custom wrappers, or every framework option.
- It does not accept inline comments or project files as approval to disable verification.
