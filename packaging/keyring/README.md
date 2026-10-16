# worksuite-archive-keyring sources

Public keys only. Private keys never enter this repository (WSOS-SEC-011).

| File | Installed to | Verifies | Comes from |
| --- | --- | --- | --- |
| `worksuite-archive-keyring.gpg` | `/usr/share/keyrings/worksuite-archive-keyring.gpg` | APT repository `InRelease` (`Signed-By` in `worksuite.sources`) | `tools/repo/keygen.sh OUT` → `OUT/archive.gpg` |
| `ed25519/device-commands/<key_id>.pem` | `/usr/share/worksuite/keys/device-commands/` | Signed policies and device commands (device agent) | `worksuite-server keys-export DIR` |
| `ed25519/release/<key_id>.pem` | `/usr/share/worksuite/keys/release/` | Release manifests (update coordinator) | `worksuite-server keys-export DIR` |

Rotation: add the new key next to the old one and ship the keyring before the server or repository starts signing
with it, then remove the old key in a later release. With no keys here the package still builds, and devices
accept no repository, policy, command or manifest: fail closed.
