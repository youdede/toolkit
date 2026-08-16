# Dependency source guard for Claude Code

This hook owns dependency source shape, not dependency versions. It detects newly introduced sources that bypass ordinary package-registry resolution in supported manifests.

Semver ranges, exact registry versions, removals, and unchanged legacy non-registry sources remain allowed. The initial scanner supports package.json dependency maps.

Other ecosystems require dedicated parsers and fixtures. The hook has no project-writable allowlist, environment bypass, or inline suppression.

## Refusals

- It does not install, resolve, upgrade, audit, or select dependency versions.
- It does not contact a registry, Git server, archive host, or local package directory.
- It does not claim that registry-resolved packages are safe, authentic, or compatible.
- It does not expose an inline suppression or project-controlled source allowlist.
