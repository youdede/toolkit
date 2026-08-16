---
name: write-incident-runbook
description: "Write or review an incident runbook for a specific service or failure mode using real signals, safe diagnostic commands, authority boundaries, containment, recovery, communication, and verification. Use before an incident or after a response exposes missing guidance."
---

# Write Incident Runbook

## Contract

A runbook supports stressed operators and must match current systems. Separate diagnosis, mitigation, and destructive recovery; name who may authorize each action.

## Build the response path

1. Define service, failure mode, impact, severity, detection signals, dependencies, on-call owner, escalation, access, sensitive data, communication obligations, and relevant objectives.
2. Write initial triage with exact safe checks, expected outputs, decision branches, known false alarms, correlation identifiers, and links to dashboards or logs. Avoid unbounded commands.
3. Specify containment and mitigation options by reversibility, blast radius, authority, customer impact, and rollback. Put destructive or data-changing recovery behind explicit approval.
4. Define recovery verification, backlog or replay, data integrity, customer communication, monitoring duration, handoff, artifact capture, and the trigger for retrospective updates.

## Validation

- Commands and links are tested in a safe environment or explicitly marked unverified.
- Each branch names evidence, owner, authority, expected effect, rollback, and escalation.
- Recovery includes user outcome, dependency, data, and objective verification.

## Stop conditions

Stop authoring when the actual architecture, access model, safe commands, decision authority, or customer and data impact cannot be verified with owners.

## Refusals

- It does not embed secrets, personal credentials, or irreversible commands as routine steps.
- It does not grant incident authority or suppress required escalation and communication.
- It does not claim a runbook is tested from document review alone.
