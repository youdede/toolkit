---
name: capture-content-idea
description: "Capture one or more content ideas into a configured append-only backlog, preserving the user’s wording and recording source context. Use for video, article, podcast, or campaign ideas, not general tasks."
---

# Capture Content Idea

## Contract

The user owns the idea and the destination. Discover or ask for the project’s configured backlog rather than assuming personal home paths.

## Workflow

1. Extract each idea and preserve its wording. Determine content type only from an explicit prefix, existing backlog taxonomy, or a single clarifying question when routing changes the destination.
2. Resolve the configured destination and read it before writing. Detect its numbering, headings, append format, encoding, and duplicate policy; never recreate a missing canonical backlog without approval.
3. Construct the complete entry before writing and check an idempotency fingerprint derived from destination, normalized idea text, and user-provided links. Append atomically with the next valid identifier and minimal provenance: date, current repository or task, and user-provided links. Do not include private chat text beyond what is needed to trace the idea.
4. Re-read the appended entry and confirm exact text, identifier, and destination. Do not commit, sync, publish, or reorder the backlog unless separately requested.

## Validation

- The appended text matches the user’s wording and existing file format.
- The identifier is unique and the destination was explicitly configured or approved.

If validation fails before the atomic append, correct the entry and retry once. If it fails after the append, do not append again or delete the entry: report the exact mismatch and request explicit authority for an in-place correction or an append-only correction record allowed by the backlog’s policy.

## Stop conditions

Stop when the destination, content classification, or permission to persist conversation-derived text is unclear.

## Refusals

- It does not assume a personal filesystem path or create a new canonical backlog silently.
- It does not rephrase, prioritize, publish, commit, or delete captured ideas.
- It does not persist unrelated private conversation as provenance.
