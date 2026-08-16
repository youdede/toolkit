# Release version consistency guard for Claude Code

This hook verifies the local metadata identity used for a Node package release. It compares package.json with package-lock.json or npm-shrinkwrap.json before publication.

Matching valid versions on a publishable package, explicit package-manager dry runs, and unrelated commands remain allowed.

Registry availability, remote tags, artifact contents, and version compatibility are outside this local deterministic check.

## Refusals

- It does not choose, increment, tag, rewrite, publish, install, or validate compatibility of a version.
- It does not contact a registry or prove that a version is available, unique, or semantically correct.
- It does not treat a matching lockfile as evidence that package contents or provenance are safe.
- It does not accept command options, prompt text, or project-authored files as a bypass.
