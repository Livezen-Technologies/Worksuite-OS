# WorkSuite APT repository

Updates reach devices through a signed APT repository, which apt verifies before installing anything
(WSOS-AUP-002). The update coordinator decides *when* to install from the signed release manifest; apt checks
*what* gets installed against the signed `InRelease`.

| Ring | Suite | Policy `update_ring` |
| --- | --- | --- |
| development | `trixie-dev` | `development` |
| pilot | `trixie-pilot` | `pilot` |
| stable | `trixie-stable` | `stable` (images ship this) |

## Once: keys (offline machine)

```sh
tools/repo/keygen.sh /secure/worksuite-keys            # OpenPGP archive key; keep /secure offline or move it into an HSM
cp /secure/worksuite-keys/archive.gpg packaging/keyring/worksuite-archive-keyring.gpg
worksuite-server keys-export --db ws.db packaging/keyring/ed25519/device-commands
worksuite-server keys-export --db ws.db packaging/keyring/ed25519/release
```

Commit the public keys and rebuild `worksuite-archive-keyring` and the image. Devices then trust that repository and
that server's signatures, and nothing else.

## Each release

```sh
packaging/build-debs.sh                                    # in Debian trixie; bump debian/changelog first
GNUPGHOME=/secure/worksuite-keys/gnupg tools/repo/publish.sh /srv/worksuite/apt trixie-dev packaging/out/*.deb
# after testing: the same .debs to trixie-pilot, then trixie-stable
worksuite-server release-publish --db ws.db manifest.json  # signed manifest per ring and arch: the coordinator's trigger
worksuite-server serve ... --apt-dir /srv/worksuite/apt     # or any static web server at https://<host>/os/apt
```

`Release` files are valid for 14 days. Re-sign each suite at least weekly with `publish.sh REPO SUITE` (no .debs),
so devices notice if a mirror is frozen on old metadata.

Tested by `tests/repo/apt-e2e.sh`, which runs real apt without root. It checks that:
- a newly published version is offered as an upgrade;
- downloads match the signed index;
- a tampered `InRelease` is refused;
- a repository re-signed with a different key is refused, with the error the package service reports as `SignatureInvalid`.
