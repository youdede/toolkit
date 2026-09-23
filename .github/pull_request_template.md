## Outcome

<!-- State the user-visible or maintainer-visible result first. -->

## Scope

<!-- Explain what changed and what deliberately did not change. -->

## Risk and trust boundaries

<!-- Cover security, compatibility, data, installer, release, and authority implications. Write "none observed" only after checking. -->

## Evidence

<!-- List exact commands and results. Distinguish observed evidence from inference. -->

- [ ] `npm run check`
- [ ] Relevant negative, malformed, boundary, and false-positive cases were exercised
- [ ] Generated catalogs and integrity metadata are current, when applicable

## Documentation and release impact

<!-- Check README when public behavior, installation, runtime coverage, counts, or evidence claims change. Update it if affected; otherwise say why no change is needed. This is a review prompt, not a required README edit. -->

README impact: updated / no change needed (reason: ...)

- [ ] User-facing behavior and refusal boundaries are documented
- [ ] Backward compatibility and migration needs are stated
- [ ] Release impact is classified: none / patch / minor / major
- [ ] No private workbench material, credentials, customer data, or source snapshots are included

## Review

- [ ] PR title follows Conventional Commits
- [ ] The change is one cohesive, reviewable concern
- [ ] I reviewed the final diff and resolved every conversation
