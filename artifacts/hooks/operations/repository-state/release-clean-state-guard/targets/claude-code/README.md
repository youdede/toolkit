# Release clean state guard for Claude Code

This hook gates a bounded list of package publication and release creation commands on observable local Git state.

Recognized: `npm`, `pnpm`, `bun`, and `cargo` `publish`, `yarn publish` and `yarn npm publish`, `twine upload` and `python -m twine upload`, `gh release create`, and these mobile store uploads: the fastlane actions `deliver`/`upload_to_app_store`, `pilot upload`/`distribute` and `upload_to_testflight`, `supply`/`upload_to_play_store` (also as `fastlane run <action>`, standalone `deliver`/`pilot`/`supply`, and through `bundle exec`), `eas submit` and `eas build --auto-submit` (also through `npx`), `xcrun altool --upload-app`/`--upload-package`, `xcrun iTMSTransporter -m upload`, and Gradle `publish*` tasks such as the Gradle Play Publisher `publishReleaseBundle` (not `publishToMavenLocal`). Commands are read through the shared item parser (`sudo`, `env`, `bash -c`, sequences); after a static `cd`, the state of that directory's repository is inspected.

The session ledger directory `.youdede/`, which the session hooks write into the workspace, does not count as a change.

Read-only release inspection, build commands, supported package-manager dry runs, and release commands in a clean attached repository remain allowed.

Remote freshness, credentials, artifact contents, branch policy, and provider approval remain separate checks.

A program the command runs but does not contain (`bash -c "$CMD"`, `curl … | sh`, `eval "$(tool)"`, `python3 -c "$CODE"`) is judged by shell-command-guard; this hook refuses one only when its text names `npm publish`, `pnpm publish`, `yarn publish`, `cargo publish`, `twine upload`, `gh release create` and similar phrases.

## Refusals

- It does not publish, tag, push, build, test, authenticate, clean, stash, commit, or repair the repository.
- It does not infer that a clean worktree is correct, releasable, reviewed, or synchronized with a remote.
- It does not recognize arbitrary aliases, shell functions, dynamic subcommands, or every release service.
- It does not treat a user-defined fastlane lane as a publication: `fastlane ios release` or `bundle exec fastlane deploy` pass even when the lane uploads, because a lane name does not show what the lane runs, and everyday lanes such as `fastlane test` must stay allowed. Call the upload action directly, or keep the lane's upload behind this check some other way. `eas update` and other over-the-air update services are not recognized.
- It does not allow a repository file, environment variable, or command flag to bypass a dirty state.

Works with shell-command-guard. Alone, this hook judges the commands it can read in the call. It cannot see inside a command that hides what it runs (`bash -c "$X"`, `curl … | sh`, `eval "$(tool)"`); shell-command-guard, installed with it by default, is the hook that stops those. The installer asks first in a terminal (default yes) and installs it with a notice elsewhere; `youdede-toolkit add release-clean-state-guard --no-prerequisites` installs this hook alone, and `youdede-toolkit add shell-command-guard` adds it later.

Retained false positives, each refused on purpose:

- `yarn publish --dry-run` is a release: no Yarn dry run is verified.
- An opaque executable (`$"x" …`, translated by the locale at run time) is uninspectable when its words can be one of the commands this hook protects.
- An option the hook has not verified, before a safe option (`npm publish --unknown --dry-run`), is read both ways, so the safe mode does not count; verifying the option into the CLI fixture fixes it.
