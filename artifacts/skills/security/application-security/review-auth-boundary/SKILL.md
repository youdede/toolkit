---
name: review-auth-boundary
description: "Review an authentication or authorization change by mapping identities, credentials, sessions, resources, policies, trust boundaries, and denied behavior. Use before merging access-control work or when a privilege, tenant, or session failure is suspected."
---

# Review Auth Boundary

## Contract

Authentication establishes an identity claim; authorization evaluates a specific action on a resource. Review both at every server-side boundary and treat client controls only as user interface.

## Trace identity to policy decision

1. Define actors, credentials, session lifecycle, tenants, resources, actions, roles or attributes, trust boundaries, service identities, threat model, and repository policy.
2. Trace login, verification, issuance, storage, transport, rotation, refresh, revocation, logout, recovery, and reauthentication. Then trace authorization at every direct and indirect resource access.
3. Test anonymous, wrong user, wrong tenant, lower privilege, revoked, expired, replayed, concurrent, confused-deputy, enumeration, and object-reference paths, plus valid controls.
4. Review logs and errors for secret or identity leakage, verify least privilege and default denial, run security and integration tests, and document residual risks and operational recovery.

## Validation

- The review maps concrete actors, actions, resources, policy points, and trust transitions.
- Negative tests prove denied access at server-side enforcement points.
- Session invalidation, tenant isolation, audit signals, and recovery behavior are verified.

## Stop conditions

Stop when the identity provider, policy owner, threat model, tenant model, secret handling, or safe test environment cannot be established.

## Refusals

- It does not weaken policy, generate real credentials, bypass controls, or test unauthorized production accounts.
- It does not treat hidden UI, route middleware, or token presence as sufficient authorization.
- It does not provide security approval beyond the exact evidence reviewed.
