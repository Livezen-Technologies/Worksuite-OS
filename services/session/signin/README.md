# worksuite-signin: device PIN and security keys

Settings › Users › Sign-in options (design boards AuthMethods, AuthPin, AuthPasskey, AuthLockPin) lets each person add
a PIN and FIDO2 security keys to their account on this device. The password always keeps working.

## Pieces

| Piece | Where |
|---|---|
| Helper (`pam-pin`, `pam-pin-used`, `pam-reset`, `serve`, `pin-set`, `pin-remove`, `key-add`, `key-remove`) | `worksuite_signin/cli.py`, installed as `/usr/lib/worksuite/worksuite-signin` |
| Verifier, lockout, method index, u2f mappings | `worksuite_signin/core.py` |
| Root PIN check daemon (socket-activated, one connection per check) | `../systemd/system/worksuite-signin.socket`, `worksuite-signin@.service` |
| PAM profiles (pam-auth-update, `Default: no`) | `../pam/worksuite-signin-pin`, `worksuite-signin-pin-final`, `worksuite-signin-u2f` |
| polkit action for Settings changes (`auth_self`) | `../polkit/lk.worksuite.signin.policy` |
| Settings UI and lock screen switcher | `shell/electron/signin.ts`, `shell/src/screens/settings/SignIn.tsx`, `shell/src/screens/Lock.tsx` |
| Lock screen (gtklock) | gtklock has one secret field and no plug-in point for buttons, so it has no switcher: it runs the same PAM stack, so a PIN typed in its field is checked as a PIN, and with a key registered pam_u2f runs first when the field is submitted and asks for a touch (not yet tried on hardware) |
| Greeter switcher | `../greeter/worksuite_greeter/login.py`, `ui.py` |

## Security decisions

- **The PIN stays on the device.** Only an scrypt verifier (N=2^15, r=8, p=1, 16-byte salt) is stored, in
  `/var/lib/worksuite/signin/pin/<uid>.json` (0600, directory 0700, root). The PIN is never written, logged or put in
  argv: Settings passes it to the D-Bus method `lk.worksuite.SignIn1.SetPin` (polkit `lk.worksuite.signin.manage`), pam_exec passes it with `expose_authtok` on
  stdin, and the helper forwards it to the root daemon over a Unix socket. The daemon answers only for the caller's own
  account (`SO_PEERCRED`), so gtklock, which runs as the user, can check that user's PIN and no one else's.
- **Lower lockout than the password.** The PIN stops working after `deny − 2` wrong tries (at most 5, at least 1;
  `deny` from `/etc/worksuite/faillock.conf`), so the password always has tries left. Wrong PINs also fall through to
  pam_unix, so pam_faillock counts them like wrong passwords. A password sign-in in a root context (greeter, polkit)
  resets the PIN count through `pam-reset`; setting a new PIN does too. Input that is not 4–12 digits is never
  treated as a PIN and never counted.
- **A PIN never unlocks LUKS.** Nothing in the initramfs, crypttab or the boot key file knows about it; the disk still
  opens with the passphrase or the boot key.
- **Security keys** use pam_u2f (libpam-u2f) with `origin=appid=pam://worksuite` and the authfile
  `/etc/worksuite/u2f_mappings` (root, 0644: key handles and public keys only). `key-add` runs `pamu2fcfg` as root
  after polkit authentication; the user is always `PKEXEC_UID`, never an argument.
- **Off by default, on once set up.** The three pam-configs are `Default: no`. The helper runs
  `pam-auth-update --enable` when someone sets up a PIN or adds a key, and `--disable` when the last one is removed.
  The profiles are system-wide, but a user without a PIN gets `no_pin` (ignored) and pam_u2f runs with `nouserok`, so
  only people who set a method up are affected.
- **One PIN length.** A new PIN is exactly `pin_min_length` digits (default 6) unless the policy also sets a longer
  `pin_max_length`; the Settings field stops at that length and the helper refuses anything else (`too_long`).
- **Security keys are detected** before `pamu2fcfg` runs: a hidraw device whose report descriptor has the FIDO usage
  page (0xF1D0). Settings reads the same sysfs files (world-readable) to say "plug in your key"; `pamu2fcfg` failures
  map to `key_not_found`, `key_timeout`, `key_pin_required`, `key_exists`, `key_unavailable` or `key_failed`.
- **D-Bus.** The service answers `Introspect` itself (it uses a raw message handler, so dbus-next has nothing exported
  to describe); the shell calls the methods by name with a fixed signature, not through an introspected proxy.
- **Policy.** `allow_pin` and `pin_min_length` (4–12) come from the signed device policy (schema
  `api-contracts/openapi.yaml`, validated in `services/server/src/console.ts`) and are written by the device agent to
  `/etc/worksuite/signin-policy.conf`. With `allow_pin=false` the helper refuses new PINs and every PIN check returns
  `disabled`.

## Keyring

GNOME Keyring encrypts the login keyring with the account password. A PIN or a security key does not give PAM that
password, so it cannot unlock the keyring, and handing the PIN to `pam_gnome_keyring` would be worse: it would fail,
and on a first sign-in could even create a keyring protected by the PIN.

So a sign-in that used the PIN leaves a one-shot marker (`/run/worksuite-signin/pin-used-<uid>`, valid 60 s). The
keyring profile runs `worksuite-signin pam-pin-used` first and skips `pam_gnome_keyring` when it succeeds. With a
security key no password is typed at all, so `pam_gnome_keyring` has nothing to use. In both cases the keyring stays
locked until an app needs it; GNOME Keyring then asks for the password once and keeps it unlocked for the session.
Settings › Users says this under the sign-in options.

## Tests

- `python3 -m unittest discover -s tests -t .` (here): verifier, weak PINs, policy, lockout, the daemon's peer checks,
  pkexec caller, pam_exec input, mappings.
- `sh tests/session/signin-pam-test.sh`: profiles off by default, priorities, PIN on stdin, keyring skip, packaging.
- `shell`: `electron/signin.test.ts`, `src/screens/settings/SignIn.test.tsx`.
