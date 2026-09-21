# Multi-component tracing

Map the actual request or artifact path before adding probes:

```text
input -> component A -> boundary -> component B -> boundary -> component C -> output
```

At each boundary capture only what distinguishes correct from incorrect behavior:

- correlation id or deterministic fixture id;
- schema/version identifier;
- presence and type of required fields, not secret values;
- status, error class, latency, and retry count;
- configuration source and non-sensitive revision;
- clock, locale, or environment when relevant.

Run the same reproduction once with probes. The first boundary whose input is correct and output is wrong identifies the component to investigate next. Remove temporary probes after verification or convert them to intentionally reviewed observability.

