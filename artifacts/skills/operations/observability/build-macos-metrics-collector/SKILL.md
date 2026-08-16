---
name: build-macos-metrics-collector
description: "Design and validate a native macOS metrics collector using supported system interfaces, bounded sampling, SQLite, and launchd. Use for local device observability where privacy and low overhead are required."
---

# Build Macos Metrics Collector

## Contract

Collect only metrics needed for the stated question. Keep data local by default, degrade gracefully when private or optional signals are unavailable, and measure collector overhead.

## Workflow

1. Define metrics, sampling intervals, retention, expected queries, privacy classification, and resource budget. Exclude content, keystrokes, credentials, and per-document history.
2. Prefer supported ProcessInfo, host statistics, power, disk, network, and thermal interfaces. Isolate optional private APIs behind nullable adapters so their failure never breaks core collection.
3. Write timestamped samples to SQLite with WAL, prepared statements, schema versioning, retention cleanup, and bounded transactions. Store the database in a private user directory.
4. Package a user LaunchAgent with explicit paths and logs. Verify sampling accuracy, sleep/wake behavior, crash recovery, database consistency, rotation, and CPU, memory, disk, and energy overhead.

## Validation

- Representative samples reconcile with a trusted system tool within documented tolerance.
- Collector overhead and retained data remain within the declared budget.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop if a desired signal requires bypassing privacy controls or if collection scope could expose user content.

## Refusals

- It does not collect screen content, keystrokes, credentials, or unrelated application data.
- It does not require private APIs for core operation.
- It does not transmit telemetry or make backups public by default.
