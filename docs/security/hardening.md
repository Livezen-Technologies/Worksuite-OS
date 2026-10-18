# WorkSuite OS security hardening

Covers WSOS-SEC-004, SEC-009, SEC-011 and SEC-012. Each section says what ships, where it lives and what checks it.

## Per-app session partitions (WSOS-SEC-004)

WorkSuite web apps open through `ws:openWorkSuiteApp(appId, url)` (`shell/electron/appwindows.ts`). Each app gets
its own window and its own persistent Electron session, `persist:ws-app-<appId>`. Cookies, storage, cache, service
workers and permission grants are separate per app, and separate from the shell's default session.

Each app window is sandboxed and context-isolated. It has no Node integration, no preload and no `<webview>`.
Every web permission request is denied, as in the shell (WSOS-SEC-003), unless an administrator granted that
permission to the requesting HTTPS origin in `/etc/worksuite/web-permissions.json` (see **Web permissions** below). Navigation stays on the app's own HTTPS
origin. Other `https:`, `mailto:` and `tel:` links open in the system browser, and anything else is refused.

Tested by `shell/electron/appwindows.test.ts`.

### WorkSuite app windows (`worksuite-app <module>`)

WorkSuite Desktop's modules run as separate processes started with `worksuite-app <module>`
(`shell/electron/appwindow.ts`): one process per module, a persistent partition per account
(`persist:account-<account id>`), sandboxed and context-isolated, no Node integration and no preload in the web
content, and navigation kept on the module's own origins. These windows grant four web permissions, and only to the
module's own origins (`allowedOrigins` in `shell/electron/webapps.ts`): `media` (camera and microphone, for Meet and
Chat), `notifications`, `clipboard-sanitized-write` and `fullscreen`. Every other permission, and every other origin,
is denied. Screen sharing is separate: only the `meet` module may ask (`SCREEN_SHARE_MODULES`), it goes through the
ScreenCast portal, whose chooser asks the user every time, and cancelling there denies.

## AppArmor (WSOS-SEC-009)

| Profile (`security/apparmor/`) | Applied by | Mode |
|---|---|---|
| `worksuite-device-agent` | `worksuite-device-agent.service` | enforce |
| `worksuite-package-service` | `worksuite-package-service.service` | enforce. `apt-get`, `dpkg` and `flatpak` run unconfined (`Ux`), because maintainer scripts are arbitrary. The service passes them fixed arguments only. |
| `worksuite-directory` | `worksuite-breakglass-rotate.service` | enforce |
| `worksuite-ai` | `worksuite-ai.service` (user unit) | enforce. The AI assistant's control service: network for model downloads (HTTPS to catalog hosts only, enforced in `services/ai/src/fetch.ts`), its own data under `~/.local/share/worksuite/ai`, reads the AI policy and catalog in `/etc/worksuite` and administrator models in `/var/lib/worksuite/ai`, starts the engine unit through the user manager. |
| `worksuite-ai-engine` | `worksuite-ai-engine.service` (user unit) | enforce. llama.cpp with no network (`deny network inet/inet6`; the unit also has `RestrictAddressFamilies=AF_UNIX`): maps model files read-only and writes only its own socket. |
| `worksuite-shell` | `worksuite-shell.service`, `worksuite-recovery-launcher.service`, `worksuite-recovery-shell.service` | complain |

Profiles are attached by name through `AppArmorProfile=-<name>` in each unit, not by path. All services run on
`/usr/bin/worksuite-node`, so a path-attached profile would confine all of them, including the PAM helper. The `-`
prefix keeps a unit working on a kernel booted without AppArmor.

Units with `NoNewPrivileges=yes` (the device agent, the rotation and both AI units) run their helpers with `ix`. Under
no_new_privs, AppArmor refuses a transition to a wider profile or to unconfined.

Packages install the profiles to `/etc/apparmor.d/`. Their postinst reloads a profile when AppArmor is active, and
`apparmor.service` loads the profiles at every boot.

The shell profile is in complain mode for now. Chromium's zygote, GPU process and renderers touch driver-specific
paths, so we collect them first. Review the `apparmor="ALLOWED" profile="worksuite-shell"` journal lines from pilot
devices, add the missing rules, then drop `complain`. `tests/security/apparmor.test.sh` allows complain mode on
`worksuite-shell` and on no other profile.

### Plan: enforcing the shell profile

The recovery screens (`worksuite-recovery-shell.service`) do not get a separate enforced profile yet. That unit
starts `worksuite-cage`, which takes the DRM device, input devices and the seat before it runs the same Electron
shell, so an enforced profile would need the same driver-specific Chromium rules as the desktop plus the
compositor's. A missing rule there would leave a device that cannot reach its recovery screens, which is the
failure recovery exists to fix, and it cannot be checked without real hardware. The steps:

1. **Collect.** Pilot devices keep complain mode. Gather the `apparmor="ALLOWED" profile="worksuite-shell"` journal
   lines from the desktop and the recovery screens (`journalctl -k --grep 'profile="worksuite-shell"'`) across the
   supported GPU drivers (i915/xe, amdgpu, nouveau, virtio-gpu, simpledrm), and add the missing rules.
2. **Recovery first.** Split out `worksuite-recovery-shell`, a child of the shell profile with an explicit
   `/usr/bin/worksuite-cage` rule and no `@{HOME}` or removable-media write access (the recovery user has neither
   need). Ship it in enforce mode once a full recovery pass (unlock, repair, reinstall keeping /home) runs with no
   denials on each driver in the hardware lab (`tests/hw`). Point the recovery unit's `AppArmorProfile=` at it and
   make `tests/security/apparmor.test.sh` require enforce for it.
3. **Desktop.** Enforce `worksuite-shell` on the pilot ring for one release with the journal watched for `DENIED`
   lines, then on stable. Drop the complain exception from `tests/security/apparmor.test.sh`.

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
| OpenPGP archive key | APT `InRelease` | HSM, or an offline machine (`tools/repo/keygen.sh`). If the optional `update-center` CI job signs, also the `WORKSUITE_ARCHIVE_GPG_KEY` GitHub secret (see **What CI holds** below) |
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
   with operator, suite and digest.

   **What CI holds.** Image builds (`.github/workflows/image.yml`, job `image`) hold no signing key: they build
   unsigned `.deb`s, ISOs and SBOMs. The one exception is the optional `update-center` job, which signs the APT
   suite it uploads to the Update Center:

   - **What:** the OpenPGP archive private key, ASCII-armoured, in the repository secret `WORKSUITE_ARCHIVE_GPG_KEY`
     (exported from the `tools/repo/keygen.sh` keyring with `gpg --export-secret-keys --armor`), and its optional
     passphrase in `WORKSUITE_KEY_PASSPHRASE`. Neither Ed25519 server key (release manifests, device commands) is in
     CI; the Update Center signs manifests with its own signing service.
   - **Scope:** the job runs only for pushed `v*` tags (`if: startsWith(github.ref, 'refs/tags/v')`), never for pull
     requests (GitHub does not pass secrets to workflows from forks), and only when the `UPDATE_CENTER_TOKEN` secret
     is set too. The key reaches one step only, "Build and sign the APT suite", as environment variables; that step
     imports it into a temporary `GNUPGHOME` (`mktemp -d`) inside a throwaway `debian:trixie` container on a
     GitHub-hosted runner, signs `InRelease`/`Release.gpg` with `tools/repo/publish.sh`, exports only the public
     keyring and deletes the `GNUPGHOME`. The workflow's token is `contents: read`. GitHub masks secret values in logs.
   - **Why:** devices only accept an APT suite whose `InRelease` verifies against `worksuite-archive-keyring`
     (WSOS-AUP-002), and the Update Center serves the uploaded suite as is, so a suite published from CI must be
     signed in CI. Without the secret the job publishes only the ISOs.
   - **Risk and the stricter path:** anyone who can push a `v*` tag, or change the workflow on a tagged commit, can
     use the key, and a GitHub secret is a file-held key, not an HSM. Restrict tag pushes (tag protection rules) and
     workflow changes to release managers. For the production archive key, leave `WORKSUITE_ARCHIVE_GPG_KEY` unset
     and sign on the release signer above, which also verifies the SBOM and checksums before it signs; CI then
     uploads only unsigned artifacts.
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
