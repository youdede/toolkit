---
name: interview-to-build-brief
description: "Ask adaptive questions to establish the user problem, evidence, falsifiable hypothesis, non-goals, authority, and acceptance criteria without smuggling engineering choices into product intent. Use when a build request is materially underspecified and guessing would change the result."
---

# Interview To Build Brief

## Contract

Ask only questions whose answers change product intent, scope, risk, or acceptance. Reuse evidence already present, separate observed problems from proposed solutions, and keep engineering approach open unless a verified constraint or user decision settles it.

## Workflow

1. Inspect available conversation and project evidence. Summarize the affected user, observed problem, current workaround, consequence, desired outcome, source confidence, and missing product decisions without treating the requested implementation as proof of need.
2. Rank unresolved decisions by consequence and irreversibility. Ask one focused adaptive question at a time only when the answer is not discoverable; offer concrete options and a recommendation when useful.
3. Establish a falsifiable product hypothesis, target users and exclusions, minimum useful outcome, success and guardrail measures, non-goals, data and authority limits, failure states, rollout constraints, and evidence that would invalidate the bet.
4. Separate product decisions from engineering constraints and open technical questions. Do not choose architecture, libraries, schemas, or task breakdown merely to make the brief look complete.
5. Synthesize a concise build brief containing problem evidence, hypothesis, users, outcomes, scope, non-goals, constraints, acceptance checks, assumptions, unresolved risks, and the next authorized planning action. Request confirmation only for material remaining ambiguity.

## Validation

- Every question changes a consequential decision and every product claim traces to supplied or discovered evidence.
- The hypothesis can fail, success measures describe user outcomes, and preferred implementation is not presented as the problem.
- Product intent, engineering constraints, agent assumptions, and unresolved questions remain visibly separate.

## Output

Return evidence, product decisions, falsifiable hypothesis, non-goals, engineering constraints, unresolved questions, acceptance checks, and next action.

## Stop conditions

Stop questioning when remaining uncertainty is low-risk and reversible discovery can resolve it. Stop before drafting when no affected user, problem evidence, decision owner, or safe discovery path can be established.

## Refusals

- It does not ask for information already available in project files or prior answers.
- It does not use an endless fixed questionnaire or block reversible progress unnecessarily.
- It does not convert an assumption or preferred implementation into a user-approved product requirement.
