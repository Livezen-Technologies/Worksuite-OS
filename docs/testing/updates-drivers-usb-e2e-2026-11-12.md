# End-to-end: driver installer, driver updater, OS updater, USB update — 2026-11-12

Installed WorkSuite OS 1.0.0~rc1 (ISO from this branch) in QEMU/TCG, UEFI, unencrypted 40 GB virtio disk, user-mode
network that reports "connected" but cannot reach Debian or the Update Center. A 300 MB FAT stick image was hot-plugged
on an xHCI controller (`tests/vm/vm.sh usb`). Screenshots: the `u*`, `d*`, `w*` series in the QA scratch directory.

**Nothing below that needs real hardware or a reachable server is recorded as passing.**

## Results

| Area | What was done | Result |
|---|---|---|
| Setup wizard on the installed OS | every step, apps, done, reboot | **Pass** after 4 fixes (below); setup does not repeat after reboot |
| Settings › Drivers: scan | devices listed (Virtio GPU, Virtio net, AHCI, virtio-pci, the hot-plugged USB stick) | **Pass** |
| Settings › Drivers: Check for drivers | runs, then says the package servers cannot be reached | **Pass** (honest error, no false "up to date") |
| Driver install / driver update | — | **Not verified.** No QEMU device needs non-free firmware or an out-of-tree driver, and the VM has no route to the archive. Needs real hardware (Wi-Fi/GPU needing firmware) and a network. Unit tests only: `services/package-service/test/drivers*.test.ts`. |
| OS updater: online check | Check for updates | **Pass** (error path): "Can't reach the update server." |
| OS updater: online install | — | **Not verified** (no reachable Update Center with a signed manifest). |
| OS updater: first view | — | **Fixed**: said "up to date" before any check (c17b501) |
| USB update in Settings | signed 1.0.0~rc2 bundle (13 packages, 138 MB) on a stick | **Blocked — release blocker.** See "AppArmor" below. Found and fixed 3 other faults on the way (7b65917, 88a3fdc, fccd3df). |
| USB boot › Update WorkSuite OS | new feature (065bc8c) | Tool tested against a fake installed system with the real bundle tool and verifier: `tests/boot/offline-update.test.sh` (14 checks incl. foreign key, tampered package, downgrade, dependency error, failed install never reported as done). **Not yet run from a rebuilt ISO in a VM.** |

## Faults found and fixed

| Commit | Severity | Fault | Root cause |
|---|---|---|---|
| fccd3df | High | Setup wizard: every answer "That didn't go through: failed"; Updates › Install now always reported failure | `busctl --json=short` prints nothing for a void method; `JSON.parse('')` threw |
| 1ffefec | Medium | First run asked for a user name (wrong, derived from the full name) and offered "Encrypt the disk" ticked on an unencrypted install; review said "Encrypt the disk: Yes" | account/encryption steps ran in firstRun mode though nothing consumes them |
| 541ec8f | Medium | VLC failed with "Unable to fetch some archives" and was given up; done screen said all apps were installed | network failures were final; done screen used the selection, not the result |
| 7b65917 | High | A plugged-in stick was never seen by Settings › Updates | nothing mounts removable media; the search only looks at mounted drives |
| 88a3fdc | High | USB bundles hidden whenever the last online check failed (always, without internet) | `showsOffline()` returned false for state `failed` |
| c17b501 | Low | "WorkSuite OS is up to date · last checked —" before any check | hero ignored `last_check == null` |

## AppArmor (open release blocker, needs a decision)

With the stick mounted, Settings › Updates › Choose file… picks the bundle and the package service answers "file not
found or is a link". Reproduced inside the service's own mount namespace:

```
nsenter -t <pid> -m -- aa-exec -p worksuite-package-service -- node -e 'fs.openSync(bundle, O_RDONLY|O_NOFOLLOW)'  → EACCES
nsenter -t <pid> -m -- node -e 'fs.openSync(bundle, 0)'                                                          → OK
```

`security/apparmor/worksuite-package-service` (enforce mode on the installed system) has no read rule for `/media`,
`/run/media` or `/mnt`, and has `deny /home/** rwx`. So under the shipped profile the service can read neither a
bundle on a USB drive nor a local `.deb` in Downloads (`/home/qat/...` is also denied), although `staging.ts` accepts
both (`BUNDLE_ROOTS`). The unit tests pass because they run without AppArmor.

The same profile also denies `mknod /run/worksuite-package-service/update-status.json.tmp`, so the update status file
for the device agent is never written (journal: `apparmor="DENIED" operation="mknod"`).

Options (not applied; this changes a root service's confinement):

1. Allow read-only access to `/media/** /run/media/** /mnt/**` and `/home/*/**` (keeping `deny /home/** wx`), plus
   `rw` on `/run/worksuite-package-service/**`. Smallest change; the service already opens exactly the path it is given
   with `O_NOFOLLOW`, checks the file belongs to the caller, and copies it before verifying.
2. Keep the profile closed and pass an open file descriptor over D-Bus instead of a path (the shell opens the file as
   the user; new `InspectBundleFd`/`InstallBundleFd`/`PreviewLocalDebFd` methods with an `h` argument). No file-system
   access for the service at all; larger change.

## Other observations

- Start button and taskbar search did not react to the VM tool's instant clicks (Super key works). Likely the tool
  clicking before the pointer has entered the layer surface; to be checked on real hardware before calling it a bug.
- The package service logs `sources_list_tidy_failed: EROFS … /etc/apt/sources.list.worksuite-tmp` at every start.
- Test-only change on the VM: a QA release key `ws-qa-test.pem` was added to `/usr/share/worksuite/keys/release/` to
  sign the test bundle (the real release key was not available). Not committed anywhere.
