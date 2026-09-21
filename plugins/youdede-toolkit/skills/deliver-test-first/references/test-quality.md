# Test quality checklist

- Name one observable behavior and avoid `and` unless both clauses form one invariant.
- Make a specific production regression capable of failing the test.
- Assert outcomes, state, or public effects instead of implementation call order.
- Keep time, randomness, network, and external services controlled.
- Include the smallest meaningful negative or boundary case.
- Keep fixtures readable; prefer local clarity over deep helper indirection.
- Ensure failures explain the broken contract.
- Clean up created resources even when the assertion fails.
- Avoid snapshots for behavior that deserves explicit assertions.
- Verify the test is stable under isolated and suite execution.

