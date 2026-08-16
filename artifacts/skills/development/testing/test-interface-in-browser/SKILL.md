---
name: test-interface-in-browser
description: "Test a web interface in a real browser across functional states, viewport behavior, console and network failures, accessibility, and persistence. Use when static review or unit tests cannot prove an important user journey."
---

# Test Interface In Browser

## Contract

Test only authorized environments and data. Define the journey and expected outcomes before interacting, preserve evidence, and distinguish application defects from environment or test setup failures.

## Exercise the user journey

1. Confirm target URL, environment, authentication method, safe test data, journey, expected states, viewports, supported browsers, and mutation or cleanup boundaries.
2. Start from a known state and exercise happy, validation, empty, loading, error, retry, permission, refresh, back-navigation, and relevant concurrency paths while observing console and network.
3. Check keyboard sequence, focus, names, headings, live errors, zoom, responsive layout, motion preferences, and screen-reader semantics appropriate to the risk.
4. Capture minimal reproducible evidence, clean up test data, run repository browser tests when available, and report defects with exact state, action, observation, expectation, and artifacts.

## Validation

- The report names environment, revision, browser, viewport, account state, and data used.
- Each finding has reproducible steps plus console, network, DOM, screenshot, or recording evidence as appropriate.
- Cleanup and remaining untested states are explicit.

## Stop conditions

Stop when the environment is production without mutation approval, credentials or test data are unsafe, rate limits or destructive actions are possible, or expected behavior is undefined.

## Refusals

- It does not bypass authentication, bot protection, access controls, or consent.
- It does not claim cross-browser or assistive-technology coverage that was not run.
- It does not alter production data or conceal console, network, or cleanup failures.
