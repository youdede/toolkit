# Release version consistency guard for Claude Code

This hook verifies the local metadata identity used for a Node package release. It compares package.json with package-lock.json or npm-shrinkwrap.json before `npm publish`. For `pnpm publish`, `yarn publish`, and `yarn npm publish` it validates package.json only, because pnpm and Yarn lockfiles do not record the root version. Commands are read through the shared shell analysis (sequences, `sudo`, `env`, `bash -c`); after a static `cd`, the package in that directory is inspected. Values of publish options such as `--tag` and `--access` are not package specs; publishing a tarball, a folder, or a workspace is refused as uninspectable.

For the mobile store uploads that `release-clean-state-guard` recognizes (fastlane `deliver`, `pilot upload`, `upload_to_app_store`, `upload_to_testflight`, `supply`, `upload_to_play_store`, `eas submit`, `eas build --auto-submit`, `xcrun altool` and `iTMSTransporter` uploads, Gradle `publish*` tasks), it reads the literal version values of the targeted platform under the project directory (and `ios/`, `android/`): Xcode `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` outside test bundles, `Info.plist` `CFBundleShortVersionString` and `CFBundleVersion` outside `*Tests` folders, Gradle `versionName` and `versionCode` in `app/build.gradle(.kts)`, and Expo `app.json` `version`, `ios.buildNumber`, and `android.versionCode`. It blocks a value outside the store format (`1`, `1.2`, or `1.2.3`; a version code from 1 to 2100000000) and iOS app and extension targets that disagree on the version or build number. Values built from variables or code (`$(…)`, `rootProject.ext…`, `app.config.js`) are skipped, Android flavors may differ, and a project without any mobile version source passes.

Matching valid versions on a publishable package, explicit package-manager dry runs, and unrelated commands remain allowed.

Registry availability, remote tags, artifact contents, and version compatibility are outside this local deterministic check.

## Refusals

- It does not choose, increment, tag, rewrite, publish, install, or validate compatibility of a version.
- It does not contact a registry or prove that a version is available, unique, or semantically correct.
- It does not treat a matching lockfile as evidence that package contents or provenance are safe.
- It does not accept command options, prompt text, or project-authored files as a bypass.
