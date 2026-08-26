# authentication-accessibility-guard

Parses bounded markup and rejects changes that newly block paste on a credential field, disable its autofill, drop the autocomplete token that identifies it, or add a password-manager opt-out attribute to it. Each is a condition W3C documents as failing WCAG 2.2 SC 3.3.8.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

A field counts as a credential field on two markers only: `type="password"`, or an `autocomplete` value holding `username`, `current-password`, `new-password`, or `one-time-code`. Forcing a person to read a secret and retype it is the transcription that SC 3.3.8 names a cognitive function test, so the guard treats removing paste or autofill from those fields as a regression rather than a preference.

Password managers have no standard opt-out attribute; each vendor reads its own. The guard recognises `data-1p-ignore`, `data-lpignore`, `data-bwignore`, and `data-protonpass-ignore`, whose names state the intent in full. A generic attribute that a framework might also use is left out rather than guessed at.

## Refusals and limits

- It does not identify a credential field from a class, placeholder, or framework binding.
- It does not report a paste block, disabled autofill, or manager opt-out that the inspected edit did not introduce.
- It does not read a paste handler nested more than one brace level deep, and it does not resolve a handler defined outside the element.
- It does not recognise every password manager's opt-out attribute, and a vendor may add one it does not know.
- It does not detect an alternative authentication method offered elsewhere, and it does not claim WCAG 3.3.8 conformance.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
