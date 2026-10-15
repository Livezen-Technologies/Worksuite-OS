# installer

Calamares configuration (WSOS-INS-001…009). `settings.conf` → `/etc/calamares/`, `modules/*.conf` →
`/etc/calamares/modules/`, `branding/worksuite/` → `/usr/share/calamares/branding/worksuite/`; packaged as
`calamares-settings-worksuite` and placed on the live ISO only. Flow: language → keyboard → disk (erase, LUKS2
option) → account → summary → **type the disk name** → install → **recovery key** → done. Enrollment (WSOS-INS-006,
P2) happens in the first-boot setup assistant.

Two WorkSuite modules, installed next to the stock ones in `/usr/lib/<multiarch>/calamares/modules/`:

- `modules/worksuiteconfirm/` (C++ view module, two instances):
  - `@erase` after the summary: reads the target disk from the partition step's planned jobs (the same list the summary
    shows; refuses if there isn't exactly one disk), shows its model and size from `lsblk`, and keeps Next disabled
    until the disk name (`nvme0n1`, `sda`, optionally with `/dev/`) is typed exactly (WSOS-INS-003).
  - `@recovery` after install: shows the recovery key once with an "I saved it" checkbox gating Next, then removes it
    from memory; skipped on unencrypted installs (WSOS-INS-004).
  - Build and test: `cmake -S modules/worksuiteconfirm -B build -DWORKSUITE_TESTS=ON && cmake --build build && ctest --test-dir build`
- `modules/worksuiterecovery/` (Python job, right after `partition`): generates a 200-bit key (8 groups of 5
  Crockford base32 characters), adds it with `cryptsetup luksAddKey` to every LUKS partition the partition module
  created, unlocking with the user's passphrase; both secrets go through 0600 files on /run, never argv. The key is
  never written to the target disk. Tests: `python3 -m unittest discover -s modules/worksuiterecovery/tests`.
