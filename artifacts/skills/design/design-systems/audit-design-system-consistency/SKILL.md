---
name: audit-design-system-consistency
description: Audit specified UI surfaces for coherent token, component, state, responsive, and accessible-semantic use with evidence and explicit uncertainty. Use when a design system or component set needs consistency review.
---

# Audit Design System Consistency

## Contract

Require a surface inventory, relevant design-system source or reference, and rendered evidence where visual claims are requested. Do not infer design intent from a component name.

## Workflow

1. Confirm the surface inventory, system contract, and available rendered evidence; record what cannot be inspected.
2. Compare representative instances across token use, variants, states, responsive behavior, and accessible semantics.
3. Group repeated evidence-backed inconsistencies and state the smallest next action without prescribing an unverified redesign.

## Validation

Inspect representative component instances and compare semantic token use, type and spacing scale, component variants, interactive/error/loading/empty states, responsive behavior, contrast/focus semantics, and documentation-to-implementation drift. Capture paths, screenshots, DOM evidence, or token references for each finding.

Write `## Reviewed surfaces`, `## Consistent patterns`, `## Findings`, `## Evidence gaps`, and `## Smallest next actions`. Classify each observation as verified, inference, or unverified. Prioritize repeated user-visible inconsistency before stylistic preference.

## Stop conditions

Stop when rendered output or the intended system contract is unavailable; request it. Refuse to call a visual outcome accessible without testing, assert brand intent without a reference, approve a redesign, or replace product/design review with this audit.

## Refusals

- Do not claim visual consistency from source code or token names alone.
- Do not infer product intent, brand rules, or accessibility conformance.
- Do not approve a redesign or replace human design review.
