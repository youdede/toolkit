---
name: compress-response-with-context
description: "Rewrite the previous answer into a shorter plain-language version with an optional compact context recap, preserving decisions, caveats, evidence, and next action. Use when the user asks for shorter or simpler."
---

# Compress Response With Context

## Contract

Reduce length, not truth. Preserve the outcome, material caveats, commitments, paths or commands the user needs, and any unresolved decision.

## Workflow

1. Identify the user’s requested compression level and whether a context recap is useful. Extract outcome, evidence, risks, decisions, and next action from the prior response.
2. Remove narration, repetition, hedging without purpose, decorative formatting, and implementation detail that does not change what the user should know or do.
3. Write a three-to-five-sentence context recap only when the user asked for it or the answer would otherwise be ambiguous. Then provide the compressed answer in plain language.
4. Compare against the original and restore any changed meaning, safety caveat, required command, file path, or ownership boundary.

## Validation

- The shorter version preserves all material decisions and caveats.
- No new fact, commitment, or interpretation was introduced during compression.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop and ask which section matters when compressing everything would remove information necessary for safe action.

## Refusals

- It does not repeat private or irrelevant early conversation merely for completeness.
- It does not remove safety, uncertainty, authorization, or rollback information.
- It does not perform new work when the request is only to rewrite the previous answer.
