---
name: design-churn-interventions
description: "Design retention interventions across cancellation, failed-payment recovery, pause, downgrade, support, and win-back paths. Use when a subscription business needs to diagnose churn mechanisms and test remedies without obstructing cancellation."
---

# Design Churn Interventions

## Contract

Preserve a clear cancellation path and customer autonomy. Segment churn by mechanism and observable context before proposing offers; retention at any cost is not the objective.

## Diagnose and intervene

1. Define churn denominator, cohort, billing state, voluntary versus involuntary split, timing, plan, tenure, usage, support history, and qualitative reasons. Validate the event model.
2. Map the exit journey and identify reversible causes: product fit, missing value, service failure, price, temporary need, payment failure, or unresolvable mismatch.
3. Design the least coercive response for each evidenced cause: fix, education, support, pause, downgrade, honest save offer, payment recovery, or clean exit. Cap frequency and preserve consent.
4. Measure retained value after a meaningful horizon, repeat cancellation, support load, refunds, complaints, and downstream trust. Retire interventions that merely delay churn or create harm.

## Validation

- Churn segments use explicit definitions and validated billing or product events.
- Each intervention maps to an observed cause and includes an unaffected control or credible comparison.
- Success includes durable retention and guardrails, not cancellation-page completion alone.

## Stop conditions

Stop when cancellation cannot remain simple, segmentation relies on sensitive inference, the billing state is unreliable, or an offer would create unequal undisclosed terms.

## Refusals

- It does not hide cancellation, add deceptive friction, shame users, or manufacture urgency.
- It does not contact users without valid consent or continue after an opt-out.
- It does not describe delayed cancellation or trapped customers as retention success.
