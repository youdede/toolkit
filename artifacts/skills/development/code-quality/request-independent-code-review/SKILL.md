---
name: request-independent-code-review
description: "Request an independent code review from another capable agent with a neutral brief and then verify every finding against the diff. Use for risky changes, disputed reviews, or before high-impact integration."
---

# Request Independent Code Review

## Contract

Use a second reviewer to create independent evidence, not borrowed confidence. Preserve its report separately, but verify and prioritize findings in the parent context.

## Workflow

1. Define the review boundary: exact diff or files, intended behavior, constraints, test evidence, and risk areas. Do not seed the reviewer with the parent conclusion.
2. Select any available independent reviewer with suitable context capacity. Do not hardcode a vendor or model; verify the invocation interface before use.
3. Ask for findings ordered by severity with file and line evidence, reproduction or failure path, and explicitly requested missing tests. Require the reviewer to distinguish defects from optional improvements.
4. Check each finding against source, requirements, and runtime evidence. Record accepted, rejected, and uncertain items with reasons, then fix only accepted in-scope defects.

## Validation

- Every accepted finding has direct code or runtime evidence.
- Relevant tests are rerun after any review-driven change.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop if the reviewer cannot access the exact revision or if sharing the code would cross an approved confidentiality boundary.

## Refusals

- It does not treat reviewer confidence, tone, or model identity as evidence.
- It does not forward secrets, customer data, or unrelated repository content.
- It does not turn style preferences into blocking defects without a project rule.
