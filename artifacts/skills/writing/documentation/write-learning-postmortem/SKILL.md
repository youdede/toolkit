---
name: write-learning-postmortem
description: "Write or review an incident postmortem from logs, timeline records, communications, and participant evidence, separating impact, contributing conditions, response, recovery, and follow-up ownership. Use after stabilization when the goal is durable learning."
---

# Write Learning Postmortem

## Contract

Explain how system and organizational conditions produced the outcome without assigning moral blame. Preserve uncertainty and privacy, and do not infer a root cause merely to complete the document.

## Reconstruct and learn

1. Gather incident declaration, impact, affected users, objective breaches, timeline sources, deployments, alerts, decisions, mitigations, recovery evidence, communications, and participant corrections.
2. Build a timestamped factual timeline with source confidence. Separate observation, interpretation, decision, action, and outcome; reconcile clocks and conflicting accounts.
3. Analyze contributing technical, process, interface, ownership, capacity, and detection conditions. Explain why defenses did not prevent or limit impact and what went well.
4. Create a small action set that changes conditions, with owner, priority, verification, due or review trigger, dependency, and link to the risk. Review the narrative with responders and affected owners.

## Validation

- Impact and timeline claims cite reliable incident artifacts and preserve disagreements.
- Analysis goes beyond the triggering event to failed or missing defenses.
- Actions are owned, verifiable, proportional, and traceable to contributing conditions.

## Stop conditions

Stop when the incident is not stable, required evidence is under legal or security hold, personal blame is being requested, or key participants have not had a chance to correct factual errors.

## Refusals

- It does not invent a single root cause, exact impact, or participant intent.
- It does not expose unnecessary personal, customer, credential, or security-sensitive details.
- It does not create vague actions such as be more careful or improve monitoring without a verifiable system change.
