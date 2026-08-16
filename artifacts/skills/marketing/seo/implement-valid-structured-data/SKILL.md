---
name: implement-valid-structured-data
description: "Implement or review structured data by selecting applicable types, mapping visible page facts, generating JSON-LD, and validating syntax and eligibility. Use when a site needs machine-readable entities or search-feature markup grounded in actual content."
---

# Implement Valid Structured Data

## Contract

Markup describes the page; it does not create facts or eligibility. Confirm the installed framework and current consumer documentation before choosing types or properties.

## Map page evidence to schema

1. Identify page purpose, canonical entity, visible facts, existing markup, rendering model, locales, templates, and the consuming validators or search features that matter.
2. Choose the smallest applicable type graph and map each property to visible or authoritative data. Define stable identifiers and relationships without duplicating contradictory entities.
3. Implement JSON-LD through the project’s established rendering path with safe serialization, correct URLs, dates, currencies, optional-field handling, and no user-controlled script injection.
4. Validate JSON syntax, schema vocabulary, consumer eligibility, rendered output, duplicate graphs, representative templates, missing data, and post-deploy pages. Monitor when content or requirements change.

## Validation

- Every property can be traced to visible content or an authoritative project field.
- Rendered HTML contains one coherent graph and passes relevant current validators with documented warnings.
- Tests cover full, partial, missing, localized, and unsafe-input records.

## Stop conditions

Stop when page facts, canonical entity identity, framework rendering, current eligibility guidance, or a safe deployment and validation path cannot be established.

## Refusals

- It does not add fake ratings, reviews, prices, availability, authorship, events, or organization facts.
- It does not guarantee rich results, ranking, indexing, or knowledge-panel changes.
- It does not suppress validator warnings or mark up content hidden from users merely to satisfy a schema.
