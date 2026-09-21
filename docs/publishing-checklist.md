# Publishing checklist

The five decisions in [release-readiness.md](release-readiness.md) under "Blocking publisher
decisions" cannot be automated. Each one needs an accountable human with credentials. This page
records what each step needs, in the order that avoids rework, and what is already prepared.

Nothing here lowers a gate. `npm run check` and `npm run check:readiness` still have to pass.
The release workflow is manual-only, requires an exact package-and-tag confirmation, scans the
complete reachable history, and refuses to publish from a private repository because npm cannot
produce provenance for that source state.

## Applying decisions 1 and 2

Both are one-line decisions with a wide blast radius: the holder string `Youdede` appears in over
300 tracked files, including the `authors` field of all <!-- stat:artifact-count -->297<!-- /stat --> `artifact.json` manifests, and the
namespace in the five files listed under step 2. [`scripts/set-publisher-identity.mjs`](../scripts/set-publisher-identity.mjs) applies either or
both in one pass, over tracked files only, and refuses to run without an explicit value. Its
`--holder` pass still targets the retired `youdede contributors` placeholder, so update its
`PLACEHOLDER_HOLDER` constant to `Youdede` in the same change before renaming the holder.

```bash
node scripts/set-publisher-identity.mjs --dry-run --holder "<exact legal name>" --owner "<github org>"
```

Check the printed file list, drop `--dry-run`, then run `npm run catalog`, `npm run integrity` and
`npm run check`. `check:legal` asserts the holder string, so a green run proves the rename is complete.

## 1. Name the copyright holder

`LICENSE`, `NOTICE` and `CITATION.cff` all carry `Youdede`. Until it is confirmed which legal person
or registered company that names, it cannot answer a licence or ownership question.

Decide which is true, then make every file agree:

- an individual, named in full; or
- a registered company, with its exact registered name.

If `Youdede` already is that exact name, record the confirmation and change nothing. Do not
substitute an invented company name. `scripts/verify-legal.mjs` asserts the current string, so
update that check in the same change.

**Files to update together:** `LICENSE`, `NOTICE`, `CITATION.cff`, `scripts/verify-legal.mjs`, and
the `authors` field of all <!-- stat:artifact-count -->297<!-- /stat --> `artifact.json` manifests.

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
- create the package through an explicit, 2FA-protected npm bootstrap only when the public release
  has been approved; never add a bootstrap token to the repository or GitHub Actions;
- once the package settings page exists, configure **trusted publishing** for this repository,
  `.github/workflows/release.yml`, and the `npm-publish` environment. This lets the workflow publish
  without a stored token;
- restrict traditional token publishing after the trusted publisher has been verified.

`package.json` declares `publishConfig.provenance: true`. The release workflow supplies the OIDC
identity, but npm supports provenance only when both the package and source repository are public.
The workflow checks repository visibility before it checks out or executes repository code; do not
disable provenance merely to publish from the temporary private phase.

## 4. Configure the release environment honestly

The `npm-publish` environment records deployments. Required environment reviewers are not available
for a private, user-owned repository on GitHub Pro, so the repository does not claim that this
environment currently supplies an independent approval. Authorization instead requires all of:

- a manual `workflow_dispatch` run;
- the exact confirmation `publish @youdede/toolkit <tag>`;
- a signed annotated tag whose commit is reachable from the default branch and whose signer is
  accepted by the default branch's `.github/allowed-signers` policy;
- every deterministic and semantic release gate.

If the repository becomes public or moves to a plan that supports reviewers for private
repositories, add the accountable publisher as a required reviewer, prevent self-review where an
independent reviewer exists, and update this page in the same change. Keep the dispatch confirmation
as an additional fail-closed control.

The only `bypass_actors` entry in [`.github/rulesets/main.json`](../.github/rulesets/main.json)
grants the repository admin role a pull-request-mode bypass. Do not add any other bypass actor.

## 5. Tag, dispatch, publish, then attest

```bash
git tag -s v0.2.0 -m "youdede toolkit 0.2.0"
git push origin v0.2.0
```

The tag must be signed and annotated, its name must equal the `package.json` version, and
`CHANGELOG.md` must document that version. The workflow verifies all three, checking the signature
against the allowed-signers policy on the default branch, and fails if the tagged commit is not
reachable from that branch. A tag cannot authorize its own signing key.

Pushing the tag does **not** start a release. In the GitHub Actions UI, manually run the `release`
workflow from the default branch with `tag` set to `v0.2.0` and `confirmation` set to
`publish @youdede/toolkit v0.2.0`. A malformed tag, mismatched confirmation, private repository,
unsupported npm runtime, history finding, or failed readiness gate stops before `npm publish`.

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
