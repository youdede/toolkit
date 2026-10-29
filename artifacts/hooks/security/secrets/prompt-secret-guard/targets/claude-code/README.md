# prompt-secret-guard

Install with `npx @youdede/toolkit add prompt-secret-guard`. The hook runs on `UserPromptSubmit`, before model processing, and returns a JSON block decision with `suppressOriginalPrompt` when a bounded high-confidence credential pattern matches. It fails closed for malformed or oversized input and never repeats the prompt in diagnostics.

The protected boundary is submitted prompt text only. It allows ordinary prose, redacted examples, and prompts without a recognized live credential format. An `sk-` word made only of lowercase letters and digits joined by `-` (such as a repository name) is not treated as an OpenAI key. It has no runtime configuration or project-writable bypass.

The credential formats are the 117 rules of the hook's `secret-rules` block, shared with commit-guard and the repository scan: private key headers and the provider prefixes or fixed structures of cloud, source-control, registry, CI/CD, observability, messaging, payment, and AI services. A format that needs a keyword next to the value, an entropy guess, a bare hex string, a UUID, or a JWT is not a rule, because those shapes also match hashes, identifiers, and documentation samples.

A block for a detected credential asks to remove or redact it; a block for a prompt over 256 KiB asks to split it; a block for unreadable hook input says so.

## Refusals and limits

- It does not reveal, persist, transmit, rotate, or revoke a detected credential.
- It does not inspect attachments, referenced files, previous turns, or assistant output.
- It does not claim complete secret coverage or replace repository and provider scanners.
- It does not accept an inline suppression, allowlist, or environment-variable bypass.
