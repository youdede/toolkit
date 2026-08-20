# Publishing checklist

The five decisions in [release-readiness.md](release-readiness.md) under "Blocking publisher
decisions" cannot be automated. Each one needs an accountable human with credentials. This page
records what each step needs, in the order that avoids rework, and what is already prepared.

Nothing here lowers a gate. `npm run check` and `npm run check:readiness` still have to pass, and
[`.github/workflows/release.yml`](../.github/workflows/release.yml) refuses to publish until they do.

## Applying decisions 1 and 2

Both are one-line decisions with a wide blast radius: the holder string appears in 278 files and the
namespace in 13. [`scripts/set-publisher-identity.mjs`](../scripts/set-publisher-identity.mjs) applies
either or both in one pass, over tracked files only, and refuses to run without an explicit value.

```bash
node scripts/set-publisher-identity.mjs --dry-run --holder "<exact legal name>" --owner "<github org>"
```

Check the printed file list, drop `--dry-run`, then run `npm run catalog`, `npm run integrity` and
`npm run check`. `check:legal` asserts the holder string, so a green run proves the rename is complete.

## 1. Name the copyright holder

`LICENSE`, `NOTICE` and `CITATION.cff` all carry "youdede contributors". That phrase identifies no
legal person, so it cannot answer a licence or ownership question.

Decide which is true, then make every file agree:

- an individual, named in full; or
- a registered company, with its exact registered name.

Do not substitute an invented company name. `scripts/verify-legal.mjs` asserts the current string,
so update that check in the same change.

**Files to update together:** `LICENSE`, `NOTICE`, `CITATION.cff`, `scripts/verify-legal.mjs`, and
the `authors` field of all 264 `artifact.json` manifests.

## 2. Migrate the namespace

The repository is `udede/toolkit`; the published identity is `@youdede/toolkit`. Until they match,
every link in the README, the CI badge, and the npm metadata points somewhere that does not exist
publicly.

Do the rename first, then update in one commit:

- `package.json`: `repository.url`, `homepage`, `bugs.url`
- `README.md`: badge URL and every repository link
- `CITATION.cff`: `repository-code`
- `.github/CODEOWNERS`: replace the temporary `@udede` owner
- `.github/ISSUE_TEMPLATE/config.yml`

Then confirm the badge renders and the issue links resolve while signed out.

## 3. Claim the npm scope

Before the first publish:

- confirm ownership of the `@youdede` scope on npmjs.com;
- require two-factor authentication for every account with publish rights;
- on the package settings page, configure **trusted publishing** for this repository and the
  `release` workflow. This is what lets the workflow publish without a stored token.

`package.json` already declares `publishConfig.provenance: true`, which was previously unbacked.
The release workflow now supplies the OIDC identity that makes it real.

## 4. Create the protected environment

In repository settings create an environment named `npm-publish` and add the accountable publisher
as a required reviewer. The `publish` job targets that environment, so a human approves each
release after the gates pass and before anything reaches the registry.

Keep `bypass_actors` empty in `.github/rulesets/main.json`.

## 5. Tag, publish, then attest

```bash
git tag -s v0.1.0 -m "youdede toolkit 0.1.0"
git push origin v0.1.0
```

The tag must be signed and annotated, and its name must equal the `package.json` version. The
workflow verifies both and fails otherwise.

After publishing, take the root digest printed by the job and put it on the authenticated GitHub
release page. A reader can then compare it against the packed npm artifact:

```bash
npx @youdede/toolkit verify-integrity
```

That comparison is the only step that turns the local checksum manifest into something a third
party can rely on, which is exactly the limit `NOTICE` and `docs/integrity.md` already state.

## What remains blocked after all five

Semantic release evidence expires after 30 days and is invalidated by any change to a prompt-bearing
payload. Regenerate it, do not carry it forward:

```bash
npm run benchmark:release:build
# run the benchmark, judge it, write the receipt
npm run check:readiness
```
