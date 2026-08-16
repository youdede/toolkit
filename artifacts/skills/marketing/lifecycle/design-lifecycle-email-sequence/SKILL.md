---
name: design-lifecycle-email-sequence
description: "Design or review welcome, activation, nurture, retention, transactional, win-back, or re-engagement email sequences using explicit states, value, consent, and suppression logic. Use when a lifecycle program needs more than isolated email copy."
---

# Design Lifecycle Email Sequence

## Contract

Sequence eligibility comes from an observable user state and valid permission. Every message must have a job, an exit condition, and a truthful relationship to the product experience.

## Model state before messages

1. Define audience state, entry event, objective, consent basis, transactional versus promotional status, exclusions, frequency policy, locale, and downstream product behavior.
2. Map the state machine with entry, delay, branching, success, failure, suppression, unsubscribe, bounce, complaint, and re-entry rules. Resolve conflicting sequences.
3. Draft each message around one user need and action, with accurate sender identity, accessible structure, supported claims, preference controls, and destination continuity.
4. Test eligibility, timing, rendering, links, personalization fallbacks, duplicate prevention, timezone, consent changes, and exits. Monitor complaints and durable user value alongside conversion.

## Validation

- The sequence diagram defines exact eligibility and exit behavior.
- Test fixtures cover missing fields, duplicate events, opt-out, success before send, locale, and delayed delivery.
- Copy and links are reviewed in rendered context with required sender and preference information.

## Stop conditions

Stop when consent, legal classification, suppression ownership, state events, sender authentication, or a safe test environment is unresolved.

## Refusals

- It does not send messages, import contacts, or configure production automation without explicit authority.
- It does not hide unsubscribe controls, continue after opt-out, or disguise promotional mail as transactional.
- It does not fabricate personalization, customer activity, scarcity, or sender familiarity.
