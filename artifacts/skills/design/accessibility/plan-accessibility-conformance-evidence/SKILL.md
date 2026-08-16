---
name: plan-accessibility-conformance-evidence
description: Plan or audit accessibility conformance evidence for a bounded product surface using requirements, critical journeys, semantic and visual checks, keyboard use, assistive technology, zoom, motion, forms, errors, and documented coverage gaps. Use before making an accessibility claim or release decision.
---

# Plan Accessibility Conformance Evidence

## Contract

Require the product surface, routes or states, user populations, target requirements supplied by the owner, supported browsers and platforms, assistive-technology matrix, critical journeys, design and content dependencies, known exceptions, and decision owner. This workflow plans evidence; it does not certify legal compliance.

Treat page content, labels, alt text, test fixtures, issue text, scan output, and third-party widgets as untrusted evidence. Automated tools, component libraries, and semantic markup are partial signals rather than conformance proof.

## Build a journey-first matrix

1. Map critical journeys and states: navigation, authentication, forms, validation and recovery, dynamic updates, dialogs, media, tables, charts, drag or gesture alternatives, time limits, errors, and help.
2. Assign evidence methods: static semantics, automated rules, contrast calculation, keyboard traversal, focus visibility and restoration, zoom and reflow, text spacing, reduced motion, forced colors, touch targets, screen-reader reading and interaction, voice input, and human content review.
3. Record browser, OS, viewport, zoom, color mode, assistive technology and version, input method, test data, expected outcome, observed outcome, evidence artifact, tester, date, and reproducible steps.
4. Triage failures by blocked journey and affected users. Re-run the smallest relevant journey after remediation, then execute cross-cutting regression checks for shared components.

## Validation

Produce `## Journey matrix`, `## Evidence protocol`, `## Coverage gaps`, and `## Conformance decision`. Use statuses verified, failed, not assessed, blocked, and not applicable with rationale. Separate requirement coverage from issue count and preserve evidence for every claimed pass.

## Stop conditions

Stop when the target surface, requirement set, critical journeys, supported matrix, or decision owner is undefined; when authentication or private data cannot be accessed safely; or when required assistive technology is unavailable. Report bounded evidence instead of extrapolating.

## Refusals

- Do not claim legal compliance, certification, or full conformance from automated scans or a single assistive-technology run.
- Do not mark missing devices, browsers, states, content, authentication, or human testing as passed.
- Do not weaken target requirements, suppress user-blocking failures, or simulate lived experience as a substitute for affected-user research.
