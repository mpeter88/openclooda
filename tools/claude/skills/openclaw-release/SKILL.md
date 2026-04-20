---
name: openclaw-release
description: Release flow — beta naming, version locations, publish gates. Activates on changelog/version-location edits.
paths:
  - "CHANGELOG.md"
  - "package.json"
  - "appcast.xml"
  - "apps/**/Info.plist"
  - "apps/android/app/build.gradle.kts"
---

# OpenClaw Release

## Channels

- stable: tagged `vYYYY.M.D`, dist-tag `latest`.
- beta: `vYYYY.M.D-beta.N`, dist-tag `beta`.
- dev: `main` head (no tag).

## Beta naming

Prefer `-beta.N`. Do not mint legacy `-1/-2` betas or `.beta.N` suffixes.

## Version locations (bump all on every release)

- `package.json` (CLI)
- `apps/android/app/build.gradle.kts` — versionName + versionCode
- `apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist`
- `apps/macos/Sources/OpenClaw/Resources/Info.plist`
- `docs/install/updating.md` — pinned npm version
- Peekaboo Xcode projects/Info.plists (MARKETING_VERSION/CURRENT_PROJECT_VERSION)

`appcast.xml` is bumped only when cutting a new macOS Sparkle release.

## Gates before publishing

Run these in order:

1. `node --import tsx scripts/release-check.ts`
2. `pnpm release:check`
3. `pnpm test:install:smoke` (or `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`)

## Changelog rules

- User-facing changes only — no version-alignment / meta notes.
- New entries at the END of `### Changes` or `### Fixes`, not the top.
- At most one contributor mention per line; prefer `Thanks @author`.

## Release auth

- Core `openclaw` publish uses GitHub trusted publishing. Do NOT use NPM_TOKEN or OTP flow for core.
- `@openclaw/*` plugin publishes use a separate maintainer-only flow.
- Version changes require explicit user consent. Always ask before running `npm publish`.
