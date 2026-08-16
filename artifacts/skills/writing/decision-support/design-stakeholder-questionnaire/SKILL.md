---
name: design-stakeholder-questionnaire
description: "Design a stakeholder questionnaire that closes a defined knowledge gap with prioritized, single-purpose questions and usable answer fields. Use when the user must obtain facts or decisions from someone with unique context."
---

# Design Stakeholder Questionnaire

## Contract

Interview the requester about the handoff, not about knowledge they do not possess. Define recipient, relationship, context, decision enabled, deadline, effort budget, confidentiality, and how answers will be used.

## Workflow

1. List the exact facts, judgments, approvals, examples, and uncertainty the requester needs from this recipient. Remove questions answerable from available files or public evidence.
2. Prioritize by decision impact because the recipient may answer only part. Split compound questions and select an answer form—fact, scale, ranking, example, choice, or free text—that matches the information needed.
3. Provide a short purpose and context, realistic effort estimate, deadline if supplied, safe return channel, permission to answer partially, and instructions for uncertainty. Explain why only where misinterpretation is likely.
4. Review every question for leading language, hidden assumptions, unnecessary personal or confidential data, jargon mismatch, and whether an answer changes the target decision.
5. Deliver a portable Markdown document with answer space and a closing opportunity to correct the framing or add omitted context.

## Validation

- Every required decision or fact maps to at least one question, and every question maps back to a declared need.
- A recipient unfamiliar with the conversation can answer without asking what the questionnaire is for.

If validation fails, narrow the requested outcome or gather missing handoff context first.

## Stop conditions

Stop when the recipient is unknown, the intended decision is undefined, or the requested data lacks a lawful and appropriate collection purpose.

## Refusals

- It does not invent the stakeholder's answer or pressure the requester to answer on their behalf.
- It does not collect credentials, unnecessary sensitive data, or information without a declared use.
- It does not bury the highest-impact questions behind optional background and low-value detail.
