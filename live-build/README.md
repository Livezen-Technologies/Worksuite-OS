# live-build

Builds the WorkSuite OS live/installer ISO from a pinned Debian **trixie** snapshot (never testing/unstable),
UEFI only (`grub-efi`, shim when Secure Boot is qualified), for amd64 and arm64 from the same tag (WSOS-ARM-001/002).

Inside Debian trixie (Ubuntu's live-build is too old for these options), with network access to snapshot.debian.org:

    packaging/build-debs.sh -d                                   # WorkSuite .debs → packaging/out
    sudo ARCH=amd64 SNAPSHOT=20261001T000000Z live-build/build.sh  # ISO → live-build/out
    tests/vm/boot-test.sh live-build/out/worksuite-os-1.0.0-dev-amd64.iso   # QEMU + OVMF boot check

`build.sh` installs the locally built .debs (`config/packages.chroot`); the WorkSuite repository is only added with
`WORKSUITE_REPO=1`, once it exists. The image boots to greetd; `worksuite-boot-marker.service` prints unit status,
the worksuite-node version and failed units to the serial console, which the boot test checks. The CI workflow
`.github/workflows/image.yml` runs all three steps on demand.

**WorkSuite Office** (the native document editors, a rebranded ONLYOFFICE DesktopEditors built by the
`Livezen-Technologies/worksuite-office` CI and published to download.worksuitecloud.com) is optional at build time.
Put its Linux .deb at `live-build/config/packages.chroot/worksuite-office*.deb` (git-ignored) or pass
`WORKSUITE_OFFICE_DEB=/path/to.deb`; `WORKSUITE_OFFICE_SHA256=<hex>` additionally pins the file. `build.sh` checks
it is a valid .deb for `ARCH`, adds its package name to the chroot package list and it is installed; without the
file the image builds without it. Nothing is downloaded during the build. The shell detects it at runtime (a desktop
entry whose id, Name or Exec mentions worksuite-office or desktopeditors) and only then shows Office, Documents,
Spreadsheets and Presentations in the start menu.

**WorkSuite Desktop, Worksuite FrameFlow and WorkSuite POS** ship the same way, so a release ISO carries all four
WorkSuite apps and installs them offline:

| App | Fetch script | Source (CI artifact) | Package, saved as | Secret / variables (image.yml) |
| --- | --- | --- | --- | --- |
| WorkSuite Desktop | `tools/fetch-desktop.sh` | worksuite-desktop `build.yml`, `worksuite-Linux` | `worksuite`, `worksuite-app_*.deb` | `WORKSUITE_DESKTOP_TOKEN` (else the Office token); `WORKSUITE_DESKTOP_URL`/`_SHA256` |
| Worksuite FrameFlow | `tools/fetch-frameflow.sh` | worksuite-frameflow (public) `desktop-build.yml`, `Worksuite-FrameFlow-Linux` | `worksuite-frameflow`, `worksuite-frameflow_*.deb` | `GITHUB_TOKEN` suffices (`WORKSUITE_FRAMEFLOW_TOKEN` overrides); `WORKSUITE_FRAMEFLOW_URL`/`_SHA256` (GitHub release or download center) |
| WorkSuite POS | `tools/fetch-pos.sh` | worksuite-pos `build.yml`, `worksuite-pos-Linux` | `worksuite-pos`, `worksuite-pos_*.deb` | `WORKSUITE_POS_TOKEN` (else the Office token); `WORKSUITE_POS_URL`/`_SHA256` |

Each script picks the deb by its control fields (Package, Architecture), never its file name; URL mode needs a
SHA256. `build.sh` validates each deb (or `WORKSUITE_<APP>_DEB=path`, pinned by `WORKSUITE_<APP>_SHA256`), checks the
package name and `ARCH`, and adds it to the chroot package list. With `WORKSUITE_RELEASE=1` each one is required
unless `WORKSUITE_<APP>_OPTIONAL=1` (image.yml sets that, with a warning, when a fetch fails, e.g. arm64, which
FrameFlow does not build yet). Their Depends come from the pinned snapshot mirror at build time, and the
`0200-worksuite-apps` hook fails the build when a bundled app's program misses a library, so the installed system
(unpackfs copies the image) runs them with no network. The app updaters do not replace a .deb install; APT does.

Installer and first boot: Calamares shows *Install WorkSuite apps* after *Install WorkSuite components*
(`shellprocess@apps`: `/usr/libexec/worksuite/worksuite-apps-check` checks each bundled package and refreshes the
desktop-entry and MIME caches). The shell gives Desktop, Office, FrameFlow and POS pinned start menu and taskbar
tiles (`shell/electron/xdg.ts` finds them by desktop entry), `shell/apps/worksuite-mimeapps.list` makes Office the
default for Office documents, the first account joins `lp` and `dialout` (POS receipt printers, cash drawers, serial
devices; `installer/modules/usersq.conf`), and WorkSuite Desktop opens on its Home once the first-run assistant ends
(first sign-in only).

WorkSuite services run on `worksuite-node` (the Node 22 inside the shipped Electron), so the image doesn't need
Debian's nodejs (20.x in trixie). Calamares joins the image once `calamares-settings-worksuite` is packaged.

Sources use deb822 with `Signed-By` (Debian keyring; WorkSuite keyring for download.worksuitecloud.com/os/apt).
Installed systems start on `trixie-stable`; the update coordinator switches suite per ring.
