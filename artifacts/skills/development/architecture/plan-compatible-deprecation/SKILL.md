---
name: plan-compatible-deprecation
description: "Plan or review deprecation of an API, configuration, data shape, dependency, feature, or workflow using consumer inventory, compatibility, migration tooling, telemetry, and explicit removal criteria. Use before announcing or implementing a breaking retirement."
---

# Plan Compatible Deprecation

## Contract

Deprecation is a supported transition, not a warning followed by deletion. Identify consumers and a viable replacement, preserve recovery, and make removal evidence-based.

## Design the transition

1. Inventory producers, consumers, owners, versions, stored data, integrations, documentation, support obligations, and current usage evidence. State what cannot be observed.
2. Define the replacement contract, compatibility strategy, warning channel, migration steps, automation, deadlines or gates, exemptions, data handling, and rollback.
3. Test mixed-version, rollback, partial migration, dormant consumer, invalid data, timeout, retry, and support paths. Provide a way to detect and correct failed migrations.
4. Produce a staged rollout plan with adoption and error checks, approved owner-contact channels, a proposed freeze on new use, removal gates, and recovery review. Planning or review does not authorize contacting owners, changing compatibility, freezing use, migrating data, or removing a surface; execute each stage only after separate explicit authorization for that stage.

## Validation

- The consumer inventory states coverage and blind spots.
- Migration is executable and tested across compatibility and rollback cases.
- Removal gates use observed remaining use, error health, support readiness, and owner approval.

## Stop conditions

Stop when there is no viable replacement, unknown critical consumers, irreversible data conversion, missing rollback, or unmet contractual and policy obligations.

## Refusals

- It does not set arbitrary deadlines or claim zero use from incomplete telemetry.
- It does not remove compatibility, data, or access without approved gates.
- It does not force consumers to discover the migration through breakage.
