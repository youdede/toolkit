---
name: keep-macos-awake
description: "Start, verify, inspect, and stop a bounded macOS caffeinate session or launch agent. Use when an approved local process must continue while the display sleeps, with removal instructions included."
---

# Keep Macos Awake

## Contract

Use the least persistent mechanism. Prefer a foreground caffeinate process tied to the target PID; use launchd only when persistence across sessions is explicitly required.

## Workflow

1. Confirm macOS, identify the process or time window, and explain battery and thermal impact. Inspect existing caffeinate and launchd state before creating anything.
2. For a bounded run use caffeinate with an explicit PID or timeout. For persistent use, create a uniquely labeled user LaunchAgent with exact arguments and no privileged paths.
3. Load or start the job through current launchctl syntax, then verify process identity, assertions, label, and logs. Avoid broad process-name matching.
4. Provide and test the matching stop or unload command. Remove only the exact file created and report whether the setting survives login.

## Validation

- The expected power assertion is visible and bound to the intended duration or process.
- The exact stop path removes the assertion without killing unrelated processes.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop if root access, device-management policy changes, or disabling system protections would be required.

## Refusals

- It does not disable sleep globally without explicit persistence requirements.
- It does not use broad kill commands that can terminate unrelated processes.
- It does not claim success without inspecting the active power assertion.
