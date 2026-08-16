---
name: define-domain-language
description: "Define or repair shared domain language by reconciling stakeholder terms, code behavior, concrete scenarios, and durable decisions. Use when overloaded vocabulary or undocumented trade-offs make design and implementation ambiguous."
---

# Define Domain Language

## Contract

Build a shared language from observed behavior and owner decisions. A glossary defines business meaning; it does not become an implementation inventory. A decision record preserves a consequential trade-off; it is not a diary.

## Workflow

1. Locate existing glossaries, architecture records, schemas, tests, interfaces, and user-facing language. Identify the applicable context before editing anything.
2. Build a term ledger with proposed canonical term, meaning, examples, non-examples, aliases, owner, and conflicts. Challenge overloaded words through concrete boundary scenarios and compare every claimed rule with current behavior.
3. Resolve one contradiction at a time with the responsible owner. Update the narrowest existing glossary only after the meaning is settled; preserve aliases as search aids without treating them as synonyms when behavior differs.
4. Record a separate decision only when it is costly to reverse, surprising without rationale, and selected among credible alternatives. Include context, decision, alternatives, consequences, evidence, status, and supersession path.
5. Re-read changed documents against code and tests. Report mismatches as open decisions instead of rewriting reality to appear consistent.

## Validation

- Every definition has at least one positive and one boundary example, and conflicting uses are resolved or explicitly open.
- Each decision record names alternatives, consequences, owner, and the evidence that justified recording it.

If validation fails, keep the term or decision provisional and request the smallest owner decision needed.

## Stop conditions

Stop before choosing business meaning on the owner's behalf, combining unrelated contexts, or changing runtime behavior merely to match a draft glossary.

## Refusals

- It does not put file paths, class names, or transient implementation detail into domain definitions.
- It does not create a decision record for routine, reversible, or uncontested choices.
- It does not erase disagreement or present inferred terminology as stakeholder-approved language.
