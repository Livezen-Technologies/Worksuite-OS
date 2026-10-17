# WorkSuite OS security hardening

Covers WSOS-SEC-004, SEC-009, SEC-011 and SEC-012. Each section says what ships, where it lives and what checks it.

## Per-app session partitions (WSOS-SEC-004)

WorkSuite web apps open through `ws:openWorkSuiteApp(appId, url)` (`shell/electron/appwindows.ts`). Each app gets
its own window and its own persistent Electron session, `persist:ws-app-<appId>`. Cookies, storage, cache, service
workers and permission grants are separate per app, and separate from the shell's default session.

Each app window is sandboxed and context-isolated. It has no Node integration, no preload and no `<webview>`.
Every web permission request is denied, as in the shell (WSOS-SEC-003). Navigation stays on the app's own HTTPS
origin. Other `https:`, `mailto:` and `tel:` links open in the system browser, and anything else is refused.

Tested by `shell/electron/appwindows.test.ts`.

## AppArmor (WSOS-SEC-009)

| Profile (`security/apparmor/`) | Applied by | Mode |
|---|---|---|
| `worksuite-device-agent` | `worksuite-device-agent.service` | enforce |
| `worksuite-package-service` | `worksuite-package-service.service` | enforce. `apt-get`, `dpkg` and `flatpak` run unconfined (`Ux`), because maintainer scripts are arbitrary. The service passes them fixed arguments only. |
| `worksuite-directory` | `worksuite-breakglass-rotate.service` | enforce |
| `worksuite-shell` | `worksuite-shell.service`, `worksuite-recovery-launcher.service`, `worksuite-recovery-shell.service` | complain |

Profiles are attached by name through `AppArmorProfile=-<name>` in each unit, not by path. All services run on
`/usr/bin/worksuite-node`, so a path-attached profile would confine all of them, including the PAM helper. The `-`
prefix keeps a unit working on a kernel booted without AppArmor.

Units with `NoNewPrivileges=yes` (the device agent and the rotation) run their helpers with `ix`. Under
no_new_privs, AppArmor refuses a transition to a wider profile or to unconfined.

Packages install the profiles to `/etc/apparmor.d/`. Their postinst reloads a profile when AppArmor is active, and
`apparmor.service` loads the profiles at every boot.

The shell profile is in complain mode for now. Chromium's zygote, GPU process and renderers touch driver-specific
paths, so we collect them first. Review the `apparmor="ALLOWED" profile="worksuite-shell"` journal lines from pilot
devices, add the missing rules, then drop `complain`. `tests/security/apparmor.test.sh` allows complain mode on
`worksuite-shell` and on no other profile.

Tested in CI (`os-scripts` job) by `tests/security/apparmor.test.sh`. It checks that every profile compiles with
`apparmor_parser`, that every confined unit names its profile, and that every profile is packaged.

## Default firewall

The image ships `/etc/nftables.conf` (`live-build/config/includes.chroot/etc/nftables.conf`), and
`0100-worksuite-defaults.hook.chroot` enables `nftables.service`. The rules live in their own table,
`inet worksuite_filter`:

- **Inbound: default deny.** Accepted are established and related traffic, loopback, ICMP errors and echo
  (rate-limited), IPv6 neighbour discovery, router advertisements and MLD, DHCP and DHCPv6 client replies, and mDNS on
  the local link (printer discovery for CUPS). Invalid packets are dropped. Nothing listens for remote connections
  (WSOS-SEC-010: no SSH server), so nothing else is opened.
- **Forwarding:** dropped.
- **Outbound:** allowed.

The device agent's managed VPN kill switch (`services/device-agent/src/vpn.ts`) uses its own table,
`inet worksuite_vpn_killswitch`, with an output policy of drop. nftables evaluates every table's base chain on a hook,
so the kill switch still blocks traffic outside the tunnel even though this table's output chain accepts. The two do
not overwrite each other: `nftables.conf` replaces only `worksuite_filter` (no `flush ruleset`), and a drop-in
(`/etc/systemd/system/nftables.service.d/worksuite.conf`) makes `systemctl stop` / `reload` touch only that table
instead of Debian's default `nft flush ruleset`.

Tested in CI (`os-scripts` job) by `tests/security/firewall.test.sh`: the file parses with `nft -c`, the input
policy is drop, the whole ruleset is never flushed and the tables differ.

## Signing keys: offline / HSM process (WSOS-SEC-011)

There are three key families. Only the public halves are in git (`packaging/keyring/README.md`).

| Key | Signs | Private half lives |
|---|---|---|
| OpenPGP archive key | APT `InRelease` | HSM, or an offline machine (`tools/repo/keygen.sh`) |
| Ed25519 release key | Release manifests | Server key store. Production: an HSM-backed KMS key |
| Ed25519 device-command key | Policies and remote commands | Server key store. Production: an HSM-backed KMS key |

Process:

1. **Generation.** Run the key ceremony on an air-gapped machine booted from a verified WorkSuite or Debian live
   ISO, with two people present. Generate the archive key inside the HSM (PKCS#11, e.g. a YubiHSM 2 or a cloud
   HSM, with `gpg --card-edit`/`gnupg-pkcs11-scd`), or with `tools/repo/keygen.sh` followed by an import into the
   HSM and a secure wipe. Write the private key only to the HSM and to two encrypted backup tokens. Store the
   tokens in separate safes.
2. **Use.** The release signer is a dedicated host that is not a CI runner. `tools/repo/publish.sh` reaches the HSM
   through `GNUPGHOME` with a PKCS#11 agent, so the private key never exists as a file. Every signature is logged
   with operator, suite and digest. CI never holds a private key. It builds unsigned artifacts and their SBOMs,
   and the signer verifies the SBOM and checksums before it signs.
3. **Rotation.** Rotate yearly, or at once if compromise is suspected. Follow the overlap procedure in
   `packaging/keyring/README.md`: ship the new public key, start signing with it, then drop the old key. If a
   key is compromised, revoke it by shipping a keyring without it, and treat devices that cannot update as
   needing a reinstall.
4. **Audit.** Review the HSM audit logs and signer logs each quarter. Two people must approve key-ceremony
   records.

`git grep -I "PRIVATE KEY"` must stay empty. The repository's tests and test servers generate their keys at run time.

## SBOM per release (WSOS-SEC-011)

`tools/sbom/generate.sh <arch>` writes `live-build/out/worksuite-os-<ver>-<arch>.spdx.json` (SPDX 2.3) from three
inputs:

- the image package list that live-build records (`*.packages`), as `pkg:deb/debian/...` purls;
- the WorkSuite `.debs`, with SHA-256 checksums;
- the shipped npm dependencies, including the Electron runtime.

When `syft` is installed, the script also writes a filesystem-level SPDX of the ISO. The image workflow runs the
script for each architecture and uploads the SBOM with the ISO. The generator is `tools/sbom/spdx.mjs`, tested by
`tools/sbom/spdx.test.mjs`.

## Electron patch policy (WSOS-SEC-012)

- **Supported line only.** The shell pins an Electron major that upstream still supports. Upstream supports the
  latest three stable majors. When a major leaves support, the shell moves to a supported major within that
  release cycle.
- **14-day window.** A security release of Electron or Chromium on our major is shipped to `stable` within
  **14 days** of its upstream publication: bump `shell/package.json` and `shell/package-lock.json`, run CI, then
  promote through `trixie-dev` → `trixie-pilot` → `trixie-stable`. For a fix that is exploited in the wild, the
  target is 72 hours.
- **Tracking.** Dependabot (or Renovate) watches `shell/package.json` for `electron`. The release owner checks the
  Electron and Chromium security advisories each week. Every Electron bump records the upstream release date and
  our stable date in `debian/changelog`, so the 14-day window can be audited.
- **No exceptions without sign-off.** If the window cannot be met, the security owner records why and what
  mitigates the risk (for example disabling the affected feature by policy), and sets a new date.
- The Electron runtime is listed in the release SBOM. Scanners can therefore flag a shipped Electron version that
  has open CVEs.

## Web content: navigation, CSP, permissions, URL schemes (WSOS-SEC-001/002/003/006)

The policy lives in `shell/electron/webSecurity.ts` and is tested by `shell/electron/webSecurity.test.ts`.

- **Shell renderers** are sandboxed and context-isolated. They have no Node integration (also not in workers or
  subframes), no `<webview>` and no insecure content. A shell window never navigates: `will-navigate` is cancelled
  and `window.open` is denied. WorkSuite app windows stay on their own HTTPS origin (`appwindows.ts`).
- **CSP.** The shipped `dist/index.html` carries a strict policy with no `'unsafe-inline'` style, no inline script
  and no remote origin (`SHELL_CSP`). The Vite build writes it in place of the development policy.
- **Web permissions** are denied by default. The shell's own session never grants any. In app partitions, an
  administrator can grant named permissions to exact HTTPS origins in `/etc/worksuite/web-permissions.json`, for
  example `{"https://meet.example.org": ["media", "notifications"]}`. Only `media`, `notifications`,
  `clipboard-sanitized-write`, `fullscreen`, `geolocation` and `display-capture` can be granted. Anything else, any
  non-HTTPS origin and any malformed entry is ignored, so it stays denied.
- **URL schemes** handed to the system are limited to `https:`, `mailto:`, `tel:` and `worksuite:`. URLs with
  embedded credentials are refused.

## What isolation we do and do not claim (WSOS-SEC-013)

WorkSuite OS isolates **web content**: each WorkSuite web app has its own Electron session partition (SEC-004),
and the renderers are sandboxed. It isolates **Flatpak apps** to the extent of their Flatpak sandbox and declared
permissions. Some privileged services run under AppArmor (SEC-009).

WorkSuite OS does **not** isolate native, unsandboxed applications of the same user from each other. Debian
packages, AppImages and scripts run with the user's full rights. They can read
each other's files, the user's documents and the session's D-Bus. Their separate `app-worksuite-*.scope` units
(SES-004) are for resource accounting and crash containment (REL-004), **not** a security boundary. Documentation,
release notes and marketing must not say otherwise. `tests/security/isolation-claims.test.sh` checks the repository
docs for claims of that kind and fails the build when it finds one.

## Secure Boot chain and key strategy (WSOS-SEC-014)

**Chain.** UEFI firmware (Microsoft UEFI CA) → Debian `shim-signed` → Debian `grub-efi-{amd64,arm64}-signed` →
Debian's signed `linux-image-*` → in-tree kernel modules signed by Debian's build key and enforced by the kernel
lockdown that Secure Boot turns on. The image is built with `--uefi-secure-boot auto`. The installer installs the
signed GRUB and shim (`installer/tests/test_config.py` checks the package set).

**Keys.**

- WorkSuite OS uses **Debian's** signing chain. We do not operate our own shim, GRUB or kernel signing key, and we
  do not ship a Machine Owner Key (MOK).
- The image and installer ship **no out-of-tree or DKMS kernel modules**. A module of that kind would be unsigned
  and would not load under Secure Boot.
- If WorkSuite ever needs its own kernel or modules, it will use a WorkSuite MOK. The key is generated and kept
  offline or in an HSM under the same process as the archive keys (SEC-011), and is enrolled with `mokutil` by the
  user at the console. Its public half ships in a package. The private key is never in the repository or CI.
- Revocation follows Debian's SBAT and DBX updates, which arrive through `shim-signed` and `fwupd` with normal
  updates.

**Advertising.** Secure Boot is **not advertised** as supported until a reference-hardware boot with Secure Boot
enabled is recorded for each architecture. That recording must show `mokutil --sb-state` = enabled, the kernel
reporting lockdown, and the installed system booting.
