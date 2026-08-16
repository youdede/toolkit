---
name: review-frontend-quality
description: Review React, Next.js, Vue, Nuxt, Svelte, SvelteKit, Angular, or framework-agnostic web interfaces for functional states, accessibility, responsive behavior, performance risks, and design-system consistency. Use before merging a UI change or when auditing an existing interface.
---

# Review frontend quality

## Contract

Review the interface against its requirements and the repository's own conventions. Prefer observed runtime behavior over static guesses. Separate verified findings from risks that still need runtime evidence.

## Establish scope

1. Identify the changed user journeys, routes, components, styles, and data boundaries.
2. Read project instructions, design tokens, component primitives, and nearby tests.
3. Detect the framework and rendering model from source and configuration. Do not rely on a remembered version.
4. Record available evidence: diff, screenshots, story, browser session, tests, accessibility scan, or performance trace.

## Review axes

### Functional states

Exercise or inspect loading, empty, success, partial, validation, error, retry, disabled, and permission-denied states. Verify state transitions and stale-response behavior.

### Accessibility

Check semantic elements, accessible names, keyboard reachability, visible focus, focus restoration, heading order, form errors, live regions, contrast, reduced motion, zoom, and screen-reader order. Prefer native elements over role emulation.

### Responsive behavior

Check narrow mobile, wide mobile, tablet, desktop, long localized text, zoom, and overflow. Verify that information priority survives rather than merely fitting.

### Design-system consistency

Check use of existing tokens and primitives, typography hierarchy, spacing rhythm, interaction feedback, content realism, and component ownership. Flag one-off raw values or duplicate components only when repository evidence establishes the convention.

### Performance and framework correctness

Inspect avoidable client work, excessive rerenders, layout shifts, unbounded lists, oversized assets, hydration boundaries, data waterfalls, and misplaced server/client responsibilities. Read [framework checks](references/framework-checks.md) for routing cues, then verify against the installed framework documentation when version-sensitive.

## Report findings

Order by user impact:

1. blocker: prevents completion, causes data loss, or creates a serious accessibility barrier;
2. high: broken common path or substantial compliance/performance risk;
3. medium: important edge case or maintainability regression;
4. low: polish with evidence of user or system impact.

For each finding include location, affected scenario, evidence, expected behavior, and the smallest likely remedy. If no actionable finding exists, say so and list the evidence actually reviewed.

## Completion evidence

Name the routes, states, viewports, assistive checks, commands, screenshots, traces, or source locations actually inspected. Mark runtime claims as verified only when the interface was exercised; keep static risks and untested paths explicitly separate.

## Stop conditions

Stop and request direction when meaningful verification requires unavailable authentication, production mutation, private user data, a missing runnable environment, or a design/product decision that repository evidence cannot resolve. Report the bounded static review already completed instead of guessing through the missing evidence.

## Refusals

- Do not invent a design system or personal style preference during review.
- Do not claim browser, accessibility, or performance verification from static code alone.
- Do not approve inaccessible behavior because a component library was used.
- Do not rewrite the interface or broaden scope unless the user separately asks for implementation.
- Do not cite framework behavior from memory when the installed version can be inspected.
