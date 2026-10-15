# worksuite-package-service

Root-owned system D-Bus service (`lk.worksuite.PackageService1`) through which the shell and App Center
install apps, apply updates and repair interrupted package operations. Interface: `dbus/lk.worksuite.PackageService1.xml`.

## Method contract

| Method | polkit action | Contract |
|---|---|---|
| `Install(source, catalog_id) → job` | `lk.worksuite.package.install` | `source` ∈ {`apt`,`flatpak`}. `catalog_id` must be present in the cached, policy-filtered `desktop/v1/os/catalog` and match the device arch (WSOS-ARM-005). No package names, URLs or repos from the caller. |
| `Remove(source, catalog_id) → job` | `lk.worksuite.package.install` | Refuses packages marked required by `worksuite-desktop`. |
| `CheckUpdates() → a{sv}` | none | Read-only: available, size, reboot need, last result. |
| `ApplyUpdate(release_id, options) → job` | `lk.worksuite.update.apply` | Runs the WSOS-UPD-001 coordinator steps: verified metadata, disk/AC/battery ≥ 40 % and lock checks, download, apply, health check, report to `desktop/v1/os/update-results`. Never removes user data or the sync outbox (WSOS-UPD-006). |
| `Repair() → job` | `lk.worksuite.repair` | Fixed commands only: `dpkg --configure -a`, then `apt-get -f install`. |
| `CancelJob(job)` | caller must own job | Only before the apply phase. |

Errors (`lk.worksuite.Error.*`): `NotAuthorized`, `NotInCatalog`, `ArchMismatch`, `Busy` (package lock held),
`PreconditionFailed` (power/disk), `SignatureInvalid`, `Failed`.

Rules (SRS §10.3, WSOS-SEC-007/008): caller UID taken from D-Bus credentials, never from arguments; polkit is
checked per call with the caller's subject; only fixed executables are spawned with argument vectors (no shell);
every privileged call is audited to journald and `desktop/v1/audit` without secrets.

Files: `polkit/lk.worksuite.package.policy`, `dbus/*.conf` (bus policy), `dbus/*.service` (bus activation), `systemd/` (unit).
