# Allowlisted Fetch Readonly — threat note

The server permits one bounded HTTPS GET only to `developer.mozilla.org`, `docs.github.com`, or
`nodejs.org`; it refuses credentials, redirects, other hosts, and responses above 256 KiB. Returned
documents are open-world, untrusted model input and can contain prompt injection. The allowlist
limits egress destinations; it does not endorse or authenticate every document served by them.
