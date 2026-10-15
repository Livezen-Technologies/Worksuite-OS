# worksuite-package-service

Root-owned system D-Bus service (`lk.worksuite.PackageService1`) through which the shell and App Center
install apps, apply updates and repair interrupted package operations. Interface: `dbus/lk.worksuite.PackageService1.xml`.

## Method contract

| Method | polkit action | Contract |
|---|---|---|
| `Install(source, catalog_id) → job` | `lk.worksuite.package.install` | `source` ∈ {`apt`,`flatpak`}; `catalog_id` is `<source>:<name>` or a bare name, validated as a plain Debian package name or Flatpak app id (no URLs, paths or options). On managed devices it must be in the signed policy `app_allowlist` (WSOS-APP-003); Flatpaks come only from the first approved remote (default `flathub`, WSOS-FLP-001). The APT plan is re-simulated inside the lock. |
| `Preview(source, catalog_id, operation) → json` | none | WSOS-APP-002: the dependency plan (`install`/`upgrade`/`remove`), disk change in bytes, and for Flatpaks the permissions with the broad ones (home/host files, all devices, X11, session bus, network) listed separately. |
| `Remove(source, catalog_id) → job` | `lk.worksuite.package.install` | WSOS-APT-003: refuses the critical set (WorkSuite session and services, greeter, locker, kernels, systemd, apt/dpkg, bootloader) directly and when a simulation shows any of it would be removed as a side effect. Flatpak removal prunes only unused runtimes (WSOS-FLP-004). |
| `CheckUpdates() → a{sv}` | none | Read-only: available, size, reboot need, last result. |
| `ApplyUpdate(release_id, options) → job` | `lk.worksuite.update.apply` | Runs the WSOS-UPD-001 coordinator steps: verified metadata, disk/AC/battery ≥ 40 % and lock checks, download, apply, health check, report to `desktop/v1/os/update-results`. Never removes user data or the sync outbox (WSOS-UPD-006). |
| `Repair() → job` | `lk.worksuite.repair` | Fixed commands only: `dpkg --configure -a`, then `apt-get -f install`. |
| `CancelJob(job)` | caller must own job | Only before the apply phase. |

Errors (`lk.worksuite.Error.*`): `NotAuthorized`, `NotInCatalog`, `InvalidArgs`, `Protected`, `SourcesInvalid`, `Busy`
(package lock held), `PreconditionFailed` (power/disk, or repair needed first), `SignatureInvalid`, `NoSuchJob`, `Failed`.

## Implementation

| File | Role |
| --- | --- |
| `src/service.ts` | Core: one serialized job queue for every APT/Flatpak change (WSOS-APT-004), policy and critical-set checks, previews, update coordinator steps (AC or battery ≥ 40 %, signed metadata refresh, disk check, download, apply, health check, reboot-needed), repair, cancellation |
| `src/apt.ts` | Parsers for `apt-get -s`, disk-space lines and `apt list --upgradable`; source checks (WSOS-APT-001/002: only Debian trixie and `download.worksuitecloud.com`, each with Signed-By, never testing/unstable — any APT operation is refused while a bad source is present); critical set; catalog-id validation |
| `src/dbus.ts` | System-bus dispatch with `dbus-next`: caller UID from `GetConnectionUnixUser`, polkit `CheckAuthorization` per call (root callers such as the device agent skip it), typed errors, `JobProgress`/`JobFinished` signals, `State`/`RebootRequired` properties |
| `src/main.ts` | Daemon: real environment (policy from `/run/worksuite-device-agent/policy.json`, `/sys/class/power_supply`, free space), boot-time `dpkg --audit` → `State=interrupted` (WSOS-APT-006) |

`npm test` runs the core tests and a D-Bus test against a private `dbus-daemon` (needs `dbus-daemon` installed).

Not yet: local `.deb` installs (WSOS-APT-005), AppImages, arch checks against the catalog (WSOS-ARM-005), reporting
to `desktop/v1/os/update-results` (the device agent's heartbeat reports update status meanwhile), and the signed
OS release manifest checks of WSOS-AUP-002/003 beyond APT's own InRelease verification.

Rules (SRS §10.3, WSOS-SEC-007/008): caller UID taken from D-Bus credentials, never from arguments; polkit is
checked per call with the caller's subject; only fixed executables are spawned with argument vectors (no shell);
every privileged call is audited to journald and `desktop/v1/audit` without secrets.

Files: `polkit/lk.worksuite.package.policy`, `dbus/*.conf` (bus policy), `dbus/*.service` (bus activation), `systemd/` (unit).
