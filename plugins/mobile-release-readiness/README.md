# Mobile release readiness

Review mobile release evidence, accessibility, and reliability. Guards stop fastlane-action, EAS, Xcode, and Gradle uploads from a dirty tree or bad versions; custom lanes pass.

## What it contains

- **Verify Mobile Release Readiness** (skill): Verify a mobile release candidate across identity, signing evidence, journeys, compatibility, rollout, and recovery.
- **Mobile Reliability Accessibility Reviewer** (subagent): Review a bounded mobile journey for lifecycle, offline, recovery, permission, and accessibility evidence gaps.
- **Release clean state guard** (hook): Require a clean attached Git worktree before a recognized package or release publication command.
- **Release version consistency guard** (hook): Require package and lockfile versions to agree before a recognized publication command.
- **Shell command guard** (hook): Block high-confidence destructive shell commands before Claude Code executes them.

## What it runs

Hooks run local Node.js scripts from `hooks/youdede/` on the tool calls and session events they declare. They make no network requests. Some run local `git` commands to read repository state.

Every member states what it refuses to do. Read each file before you install it.

Source and evidence: https://github.com/youdede/toolkit/blob/main/packs/mobile-release-readiness/pack.json

License: MIT. See `LICENSE` and `NOTICE`.
