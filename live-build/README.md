# live-build

Builds the WorkSuite OS live/installer ISO from a pinned Debian **trixie** snapshot (never testing/unstable),
UEFI only (`grub-efi`, shim when Secure Boot is qualified), for amd64 and arm64 from the same tag (WSOS-ARM-001/002).

    cd live-build
    ARCH=amd64 SNAPSHOT=20261001T000000Z lb config && sudo lb build
    ARCH=arm64 SNAPSHOT=20261001T000000Z lb config && sudo lb build   # native arm64 builder

Sources use deb822 with `Signed-By` (Debian keyring; WorkSuite keyring for download.worksuitecloud.com/os/apt).
Installed systems start on `trixie-stable`; the update coordinator switches suite per ring.
