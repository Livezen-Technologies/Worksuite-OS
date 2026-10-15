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

WorkSuite services run on `worksuite-node` (the Node 22 inside the shipped Electron), so the image doesn't need
Debian's nodejs (20.x in trixie). Calamares joins the image once `calamares-settings-worksuite` is packaged.

Sources use deb822 with `Signed-By` (Debian keyring; WorkSuite keyring for download.worksuitecloud.com/os/apt).
Installed systems start on `trixie-stable`; the update coordinator switches suite per ring.
