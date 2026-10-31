# Pack evidence reports

A pack evidence report records which declared member artifacts support each pack outcome. It is a
bounded receipt, not a claim that the underlying work is correct, approved, or safe to release.

Every pack manifest declares:

- a semantic pack version;
- the report schema at `schema/pack-evidence.schema.json`;
- a required link to one hash-chained session-ledger entry;
- exactly one evidence mapping for every outcome; and
- the pack members permitted to support that outcome.

Reports are JSON files no larger than 1 MiB. They must be regular files rather than symbolic links,
use the published schema identifier, match the ID and version of the pack in the toolkit catalog, cite a SHA-256 session
ledger entry, and contain every outcome exactly once. A verified outcome must include one unique
evidence record for every member named by its mapping. Claims are short descriptions; their hashes
bind the claim to the evidence material retained by the workflow.

Validate a report without changing the workspace:

```bash
npx @youdede/toolkit verify-pack-evidence daily-driver \
  --report .youdede/evidence/daily-driver.json
```

Add `--json` for a machine-readable verdict. The verifier fails closed on an unknown member,
missing or duplicated evidence, an invalid hash, a version mismatch, an incomplete outcome set, or
an unexpected field.

The verifier establishes structural completeness and identity only. It does not replay commands,
inspect the evidence material behind a hash, approve a change, or replace a human review. Pack-level
behavioral cases under `packs/*/evaluations/behavioral.json` separately exercise the accepted path,
missing evidence, ledger mismatch, and unsupported installation coordinate.
