# Reviewable change

Prepare bounded code changes, obtain independent review, and prevent oversized unreviewable commits.

## What it contains

- **Assemble Review Brief** (command): Assemble a review brief from the real diff: scope, risk notes, and test evidence a reviewer can check line by line.
- **Prepare Reviewable Pull Request** (skill): Prepare a focused pull-request narrative whose claims trace to the diff, tests, risks, and review order.
- **Evaluate Code Review Feedback** (skill): Evaluate review feedback against the code, contract, and evidence before applying a bounded correction.
- **Request Independent Code Review** (skill): Obtain a neutral second review and reconcile it against the actual change.
- **Refactor Equivalence Reviewer** (subagent): Compare a bounded before-and-after refactor for unintended observable behavior changes.
- **Large diff review guard** (hook): Require a smaller staged change when a commit exceeds bounded reviewability thresholds.
- **Shell command guard** (hook): Block high-confidence destructive shell commands before Claude Code executes them.

## What it runs

Hooks run local Node.js scripts from `hooks/youdede/` on the tool calls and session events they declare. They make no network requests. Some run local `git` commands to read repository state.

Every member states what it refuses to do. Read each file before you install it.

Source and evidence: https://github.com/youdede/toolkit/blob/main/packs/reviewable-change/pack.json

License: MIT. See `LICENSE` and `NOTICE`.
