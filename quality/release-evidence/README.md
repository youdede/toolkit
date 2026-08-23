# Signed semantic release evidence

Release candidates place two review artifacts in this directory:

- `semantic-release-evidence.json`: the current, schema-valid semantic receipt.
- `semantic-release-evidence.sig`: a base64 Ed25519 signature over the exact JSON file bytes.

The private signing key is never stored in this repository. The matching public key is pinned in
the protected `semantic-evidence` GitHub environment as `SEMANTIC_EVIDENCE_PUBLIC_KEY`. The release
workflow copies the receipt into the ignored workbench location, rebuilds its benchmark inputs, and
accepts it only when the signature, freshness, coverage, thresholds, and benchmark digest all match.

Presence of a signed receipt does not imply a passing release. A complete evaluation that finds a
semantic or fixture failure is retained and signed so that the protected gate fails on the current
evidence instead of silently falling back to an older passing sample.

Do not add placeholder receipts or signatures. Absence is a deliberate release-blocking state.
