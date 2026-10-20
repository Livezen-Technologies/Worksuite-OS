# installer

Calamares configuration (WSOS-INS-001…009). `settings.conf` → `/etc/calamares/`, `modules/*.conf` →
`/etc/calamares/modules/`, `branding/worksuite/` → `/usr/share/calamares/branding/worksuite/`; packaged as
`calamares-settings-worksuite` and placed on the live ISO only. Flow: language → keyboard → disk (erase, LUKS2
option) → account → enrollment (optional, **Skip for now**) → summary → **type the disk name** → **accept the terms**
→ install → **recovery key** → done.

Two WorkSuite modules, installed next to the stock ones in `/usr/lib/<multiarch>/calamares/modules/`:

- `modules/worksuiteconfirm/` (C++ view module, four instances):
  - `@erase` after the summary: reads the target disk from the partition step's planned jobs (the same list the summary
    shows; refuses if there isn't exactly one disk), shows its model and size from `lsblk`, and keeps Next disabled
    until the disk name (`nvme0n1`, `sda`, optionally with `/dev/`) is typed exactly (WSOS-INS-003).
    The disk is read with `lsblk` in the background ("Reading the disk…"). Operating systems already on it (dual-boot
    machines: Windows/NTFS/BitLocker, Linux, macOS) are listed by name and partition, and Install also needs the box
    "I understand that the systems listed above will be permanently removed"; a line under the field says what is
    still missing. The Disk page (`WsStyle.cpp`) names the same systems as soon as a disk is selected.
  - `@enroll` after the account page (optional, WSOS-INS-006): server and code, the console's link or its QR code.
    **Skip for now** (or Continue with both fields empty) clears the fields, writes no token file and moves on; the
    sidebar marks Your account › Enrollment as skipped.
  - `@terms` last before Install: the WorkSuite OS terms (`branding/worksuite/terms/LICENSE-<lang>.txt`, en/si/ta,
    **drafts: replace with the final legal text before release**) and a box that must be ticked before Install;
    `accepted: true` in `worksuiteconfirm-terms.conf` pre-accepts for unattended/OEM images. The `worksuiteterms` job
    writes the accepted version and time to `/var/lib/worksuite/terms-accepted` (0644, no personal data).
  - The loading screen (`WsIntro.cpp`): on the live ISO the installer starts behind the animated veil
    (`worksuite_greeter.veil --installer`); Calamares draws the same frame when its window first shows and cross-fades
    into the Language page, the mark gliding into the sidebar logo (reduced motion: a still frame and a plain fade).
  - `@recovery` after install: shows the recovery key once with an "I saved it" checkbox gating Next, then removes it
    from memory; skipped on unencrypted installs (WSOS-INS-004).
  - Build and test: `cmake -S modules/worksuiteconfirm -B build -DWORKSUITE_TESTS=ON && cmake --build build && ctest --test-dir build`
- `modules/worksuiterecovery/` (Python job, right after `partition`): generates a 200-bit key (8 groups of 5
  Crockford base32 characters), adds it with `cryptsetup luksAddKey` to every LUKS partition the partition module
  created, unlocking with the user's passphrase; both secrets go through 0600 files on /run, never argv. The key is
  never written to the target disk. Tests: `python3 -m unittest discover -s modules/worksuiterecovery/tests`.

## Disk layout and the passphrase prompt

Encrypted installs get the ESP, an unencrypted `/boot` (ext4, 1 GiB: kernel and initramfs only) and the root in
LUKS2 (argon2id; the recovery key in its own key slot). GRUB reads `/boot` without asking (`GRUB_ENABLE_CRYPTODISK=n`,
menu hidden), and the initramfs asks for the passphrase once, in the WorkSuite splash's password field: no text
console at any point. An unencrypted `/boot` is the Debian and Ubuntu default; Secure Boot with signed kernels covers
its integrity.

