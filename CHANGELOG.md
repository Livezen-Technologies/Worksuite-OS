# Changelog

All notable changes to WorkSuite OS are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Per-package detail for the Debian packages is in
[`packaging/debian/changelog`](packaging/debian/changelog).

## [1.0.0-rc1] — 2026-11-04

First published build. Consolidates the three development builds
(`1.0.0~dev1`–`1.0.0~dev3`) that were built but never released.

### Added
- Live ISO for amd64 and arm64, built with live-build from a pinned
  snapshot.debian.org timestamp, with the WorkSuite GRUB boot theme.
- Debian packages: the shell, the session, the user services (sync and the
  credentials broker), the package service and the device agent.
- Settings › Drivers: Debian's own APT sources are recognised (deb822
  embedded `Signed-By` keys, `*.debian.org` mirrors, mirrors pinned to
  Debian's archive keyring, http/https duplicates and installation-disc
  entries). A mirror other than deb.debian.org or security.debian.org is
  accepted only when it is pinned to Debian's archive keyring; other
  `*.debian.org` hosts carrying their own key are refused like any
  third-party archive. `trusted=yes` and missing `Signed-By` keyrings are
  refused by name, and a failed install names the stage and the source.
- Settings › Security: Quick scan and Full scan report the engine's real
  state when they cannot start — definitions still downloading, updater
  failed or absent, engine not responding, or a fault in the agent itself.
  A stopped `freshclam` is started on demand, a scan that stops says why,
  and scan units may use 2 GB before being throttled so that loading
  ClamAV's signature database no longer stalls a scan on a machine without
  swap. The image creates `/var/lib/clamav` and `/var/log/clamav` at boot.
- Accessibility panel in the taskbar, built from the design system: Display
  and Language groups, a segmented text-size control operable by arrow keys,
  a full-width language picker, and theme variables with rem sizes so it
  scales. It holds its layout at 150% and 200% text, and its switches are
  visible in high contrast.

### Known limitations
- **No signed APT update channel.** `WORKSUITE_ARCHIVE_GPG_KEY` is not
  configured, so the signed APT suite is not built or published with this
  release. Machines installed from this ISO have no update source until a
  later release ships one. Do not treat 0.1.0 as a maintained install.
- Published to the `development` ring only.

### Versioning note
This release stays in the 1.0 series on purpose. The WorkSuite Desktop
package declares `Breaks: worksuite-desktop (< 1.0~)` so that the old 0.x
application is told apart from this OS metapackage. Numbering the OS below
`1.0~` makes the image unresolvable at build time — apt reports
`Breaks: worksuite-desktop (< 1.0~) but 0.1.0 is to be installed` and the
live-build run fails. A 0.x version for WorkSuite OS is not available.
