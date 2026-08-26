# accessibility-attribute-regression-guard

Parses bounded markup and rejects two changes: one that drops an accessible name, role, or relationship from an element the edit keeps, and one that hides a focusable element from assistive technology while it still takes keyboard focus.

The second check is the rule W3C states in Using ARIA: do not use `role="presentation"` or `aria-hidden="true"` on a focusable element. The element keeps taking focus while the accessibility tree says nothing is there, so a screen reader user reaches it and hears silence. Pairing `aria-hidden="true"` with `tabindex="-1"`, which is how an element is correctly taken out of both, is not blocked.

A tag ends at the first `>` that sits outside quotes and outside a braced expression. Ending it at the first `>` truncated every JSX tag at the arrow in its first handler, which hid every attribute written after it.

The hook is deterministic, reads at most 1 MiB from stdin, emits exit code 0 to allow and 2 to block, and never repeats submitted content in a diagnostic. It has no project-writable exception file.

## Refusals and limits

- It does not judge whether a name or role is accurate, only whether the change removed one that was there.
- It does not see a focusable child inside a hidden wrapper, because it reads elements individually rather than as a tree.
- It does not track an element that carries no `id`, test id or `name` across an edit; those are judged by how many of their kind still carry a name or a relationship, so stripping one is caught and adding one is not.
- It does not report a hidden focusable element that the inspected edit did not introduce.
- It does not claim accessibility conformance.
- It does not call an LLM, execute submitted shell text, or transmit inspected content.
