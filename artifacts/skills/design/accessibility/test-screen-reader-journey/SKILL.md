---
name: test-screen-reader-journey
description: "Test a web or application journey with a specified screen reader and browser combination, covering navigation, names, roles, state, focus, reading order, live feedback, and recovery. Use when semantic inspection alone cannot prove assistive-technology behavior."
---

# Test Screen Reader Journey

## Contract

Use a real supported screen reader and identify the exact environment. Test task completion and comprehension, not a recital of every announced node.

## Exercise the assisted journey

1. Define journey, expected outcome, platform, browser, screen reader and version, input mode, starting state, test data, supported combinations, and cleanup.
2. Navigate by reading, headings, landmarks, links, controls, forms, tables, and application-specific shortcuts as relevant. Record unexpected order, verbosity, omissions, and traps.
3. Exercise labels, descriptions, expanded and selected state, errors, live updates, dialogs, focus transitions, routing, loading, validation, retry, and return to context.
4. Reproduce findings with exact keystrokes and state, compare semantic tree and source, verify a control path, and report user impact plus the smallest likely correction.

## Validation

- The report names actual screen reader, browser, platform, version, settings, and journey.
- Each finding includes keystrokes, announcement, focus state, expected outcome, and reproducibility.
- Static semantics and runtime announcements are kept distinct.

## Stop conditions

Stop when the required assistive technology is unavailable, the environment is unsafe, test accounts are missing, or destructive actions cannot be isolated.

## Refusals

- It does not claim screen-reader verification from DOM inspection or automated rules alone.
- It does not generalize one browser and screen-reader combination to all assistive technology.
- It does not expose private spoken content or mutate production data without authority.
