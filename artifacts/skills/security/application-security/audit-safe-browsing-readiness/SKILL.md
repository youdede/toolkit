---
name: audit-safe-browsing-readiness
description: "Assess whether a public website is ready for reputation and malware-review systems using observable security, ownership, content, and indexing signals. Use before submitting a site for review or diagnosing a warning."
---

# Audit Safe Browsing Readiness

## Contract

Treat reputation decisions as external and probabilistic. Verify the deployed surface and official console status; do not promise approval or invent undocumented scoring rules.

## Workflow

1. Inspect the exact public URLs, redirects, TLS, headers, downloads, forms, scripts, third-party resources, robots directives, and visible ownership or contact information.
2. Scan the repository and deployment artifacts for injected scripts, obfuscation, credential collection, unsafe redirects, compromised dependencies, and deceptive content. Separate confirmed defects from weak signals.
3. Use official site-owner and security tools where authorized to check indexing, security issues, manual actions, and current review status. Follow current official documentation rather than reverse-engineered endpoints.
4. Produce a remediation, deployment, re-scan, and official-submission plan for verified causes. An audit does not authorize repository changes, deployment, console submission, or polling. Perform each effect only under separate explicit authority, record its before and after state, and never repeat a non-idempotent submission merely because status is delayed.

## Validation

- The audited revision is the one deployed at the inspected URLs.
- All findings cite live evidence or official console output.

If validation fails before any external effect, correct the plan and repeat the check. After a change, deployment, or submission, stop and report the exact partial state; roll back only a verified change covered by the authorization, and do not redeploy or resubmit automatically.

## Stop conditions

Stop if console access, domain ownership, or permission to inspect the live system is missing. Also stop before fixes, deployment, review submission, or monitoring when the corresponding authority is absent.

## Refusals

- It does not guarantee allowlisting, ranking, indexing, or review timing.
- It does not automate undocumented private APIs or evade platform controls.
- It does not hide harmful behavior solely to pass a reputation check.
