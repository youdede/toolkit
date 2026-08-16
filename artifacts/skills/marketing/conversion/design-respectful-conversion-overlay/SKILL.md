---
name: design-respectful-conversion-overlay
description: "Design or review a popup, modal, banner, slide-in, or sticky conversion prompt with contextual value, accessible behavior, clear dismissal, frequency limits, and consent-aware measurement. Use when an interruptive surface is being considered or underperforming."
---

# Design Respectful Conversion Overlay

## Contract

An overlay borrows attention and must repay it with relevant value. It may not block essential content, obscure consent, or repeatedly punish refusal.

## Define trigger and interaction

1. Set the user state, objective, value, trigger evidence, exclusions, frequency cap, persistence, device behavior, consent implications, and what happens after acceptance or dismissal.
2. Choose the least disruptive surface and timing. Define focus entry and return, keyboard behavior, labels, screen-reader semantics, zoom, reduced motion, backdrop, scroll, and error states.
3. Write one clear promise and action with visible dismissal, truthful terms, minimal fields, and a destination continuous with the request. Avoid interference with critical tasks.
4. Test trigger accuracy, repeat visits, dismissal memory, consent changes, mobile viewport, assistive technology, slow loading, conflicting overlays, and qualified downstream value.

## Validation

- Trigger, exclusions, cap, dismissal persistence, and post-action state are explicit.
- Runtime evidence covers keyboard, focus, screen reader, zoom, mobile, and error behavior.
- Measurement includes annoyance, complaints, dismissal, task completion, and lead quality.

## Stop conditions

Stop when the overlay would cover critical content, override consent, interfere with authentication or payment, or cannot provide reliable dismissal and focus restoration.

## Refusals

- It does not use fake close controls, repeated reappearance, forced countdowns, or misleading system-style alerts.
- It does not capture contact or sensitive data without appropriate notice and permission.
- It does not trade accessibility or core task completion for opt-in rate.
