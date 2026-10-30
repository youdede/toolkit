# Accessibility assurance

Plan, enforce, and independently verify accessible interface behavior from source evidence.

## What it contains

- **Authentication Accessibility Guard** (hook): Block edits that stop a password manager filling an authentication field or stop the user pasting into it.
- **Focus Style Regression Guard** (hook): Block newly invisible CSS focus states that have no visible replacement.
- **Accessibility Attribute Regression Guard** (hook): Block net removal of explicit accessibility relationships from markup changes.
- **Plan Accessibility Conformance Evidence** (skill): Plan accessibility evidence across user journeys, automation, keyboard, assistive technology, and human review.
- **Prepare EAA Conformance Evidence** (skill): Map accessibility results to the requirement set and version an owner declared, keeping verified, asserted, stale and absent apart.
- **Test Screen Reader Journey** (skill): Test a bounded user journey with a real screen reader and evidence tied to interaction outcomes.
- **Verify Cognitive Access Barriers** (skill): Verify consistent help, redundant entry, and accessible authentication against an observed process walkthrough.
- **Accessibility Conformance Reviewer** (subagent): Review a bounded interface change for evidence-led accessibility conformance risks and user barriers.
- **Accessibility Journey Tester** (subagent): Verify a bounded user journey from supplied browser, keyboard, assistive-technology, and static evidence.

## What it runs

Hooks run local Node.js scripts from `hooks/youdede/` on the tool calls and session events they declare. They make no network requests. Some run local `git` commands to read repository state.

Every member states what it refuses to do. Read each file before you install it.

Source and evidence: https://github.com/youdede/toolkit/blob/main/packs/accessibility-assurance/pack.json

License: MIT. See `LICENSE` and `NOTICE`.
