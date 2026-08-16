---
name: research-online-purchase
description: "Research an online purchase using current prices, seller evidence, total delivered cost, product fit, and scam signals. Use when comparing listings or deciding whether, where, or when to buy."
---

# Research Online Purchase

## Contract

Match effort to price and consequence. Give the user a concise verdict based on current evidence while keeping checkout, account creation, payment, and personal details out of scope.

## Workflow

1. Identify the exact model or variant, intended use, delivery country, timing, must-have features, and budget. Ask only when missing information would change the recommendation.
2. Choose a research tier: no search for an obvious low-cost answer; one quick check for cheap uncertain items; multiple current listings and reviews for higher-cost or high-risk purchases.
3. Compare like-for-like condition, warranty, tax, shipping, return policy, stock, and seller identity. Verify unknown stores through company details, independent reputation, domain history signals, and realistic pricing.
4. Return a verdict, fair-price range, two or three suitable sellers with observed local-currency prices and timestamps, key tradeoffs, and any scam or compatibility warning. State when evidence is thin.

## Validation

- Quoted prices come from opened current listings and include material total-cost caveats.
- The recommendation matches the user’s actual use and delivery market.

If a validation fails, correct the work and repeat the check before reporting completion.

## Stop conditions

Stop before creating an account, accepting terms, entering an address, applying for credit, or placing an order.

## Refusals

- It does not purchase, reserve, bid, create accounts, or enter payment or address data.
- It does not quote a price that was not directly observed in a current source.
- It does not recommend an unknown seller solely because it is cheapest.
