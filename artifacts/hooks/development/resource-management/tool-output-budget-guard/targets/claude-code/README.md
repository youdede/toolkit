# tool-output-budget-guard

Measures shell tool output against a declared 64 KiB per-call budget after the call completes, and emits bounded guidance (pagination, filtering, redirect-to-file) when output exceeds it. Context pressure becomes a visible signal instead of silent truncation risk.

The hook reads at most 8 MiB of observation input; larger input is reported as exceeding that limit without being parsed. It never echoes observed content and always exits 0.

## Refusals and limits

- It does not rewrite, truncate, or delay tool output; it observes and advises.
- It does not judge whether large output was justified; the budget signal is informational.
- It does not inspect non-shell tools or file contents.
- It does not transmit any measured content; diagnostics carry byte counts only.
