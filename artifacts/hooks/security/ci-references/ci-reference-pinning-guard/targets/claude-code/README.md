# CI reference pinning guard for Claude Code

This hook protects CI execution identity. It compares the existing workflow with the proposed complete content and rejects only newly introduced external execution references that are not immutable.

Local actions, full 40-character Git commits, container digests, removal of mutable references, and unchanged legacy findings remain allowed.

A finding is identified by its rule and normalized reference, so replacing one mutable reference with another is a new finding. The scanner covers `uses:` references, `docker://` actions, `jobs.<id>.container` (scalar or `image:`), and `jobs.<id>.services.<id>.image` in GitHub Actions workflows, recognized from the resolved file path (`<root>/.github/workflows/<name>.yml`), so the absolute paths Claude Code sends and edits from another current directory are covered. It does not query providers or infer that a pinned dependency is trustworthy. The hook has no project-writable allowlist, environment bypass, or inline suppression.

## Refusals

- It does not execute, validate, repair, approve, or publish a CI workflow.
- It does not resolve tags, branches, action metadata, container registries, or network identities.
- It does not treat comments, prompt text, or a project-authored allowlist as authorization to bypass pinning.
- It does not claim support for CI providers or reference syntaxes outside its documented scanners.
