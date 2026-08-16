# Security policy

## Supported versions

Until the first public release, security fixes are applied to `main`. After publication, the latest stable npm release and `main` receive security fixes; older versions are supported only when a release note says otherwise.

## Private reporting

Do not open a public issue for a suspected vulnerability. Use the repository's **Security → Report a vulnerability** flow to create a private security advisory. Include the affected artifact id and version, target runtime, reproduction, impact, and a minimal safe proof of concept. Do not include real credentials or third-party private data.

The maintainer will acknowledge a complete report, assess severity and affected versions, coordinate a fix, and publish an advisory when users need to take action. Timelines depend on reproducibility and impact; no remediation date is promised before triage.

## Security boundary

Artifacts must not collect credentials, transmit repository contents, hide network access, execute downloaded code, or alter permissions outside their documented install root. The installer does not execute installed payloads. Integrity manifests detect byte drift but do not prove authorship, safety, or publisher identity; release authentication additionally depends on the signed Git tag and npm provenance.
