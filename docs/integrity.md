# Integrity, authorship, and release provenance

`catalog/integrity.json` contains one deterministic attestation per artifact. An attestation covers:

- the stable artifact id and semver version;
- the manifest's contributor and license declarations;
- every regular file below the artifact directory; and
- shared package runtime files mapped by an adapter, such as target hook bridges.

Paths are sorted, every file uses SHA-256, and the attestation digest hashes a domain-separated canonical JSON record. The catalog root digest hashes the ordered set of attestations. There is no generation timestamp, so identical public inputs produce identical output.

Verify the checkout or installed npm package before use:

```bash
node ./bin/youdede-toolkit.mjs verify-integrity
node ./bin/youdede-toolkit.mjs verify-integrity debug-systematically
```

The installer performs the same per-artifact check before planning or copying a bundled artifact. A mismatch stops installation. `npm run check:integrity` rejects stale attestations during CI and before publication.

## Claim boundary

These are transparent checksums, not hidden watermarks and not a private-key signature. They detect drift relative to the included manifest. If an attacker can replace both artifacts and the manifest, local verification alone cannot authenticate the publisher. For a release, compare the root digest through an independently authenticated channel, verify the signed Git tag, and retain npm provenance from the trusted publisher workflow.

The `authors` field identifies contributors to the toolkit artifact as assembled here. A checksum does not prove originality, license compliance, endorsement, ownership, or the identity of a contributor.

The MIT license permits copying subject to its notice-retention terms. No prompt, metadata field, checksum, or AI instruction can guarantee that a model or third party will refuse copying.
