# Setup app installation, end to end

Runs the real setup app engine (`services/setup/src/apps`) against the real apt, dpkg and flatpak in a clean Debian 13 container, with the real WorkSuite packages as the bundled set.

1. Put the five WorkSuite `.deb` files in a directory as `<package>_<version>_<arch>.deb`, then run `sha256sum *.deb > SHA256SUMS` there.
2. Run, from the repository root (Node 22.18 or newer at `/opt/node22`):

```bash
docker run --rm --network host -e PATH=/opt/node22/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -v /opt/node22:/opt/node22:ro -v "$PWD/services/setup:/src:ro" -v "$BUNDLED:/bundled:ro" \
  -v "$PWD/tests/setup-apps:/e2e:ro" -v /etc/ssl/certs/ca-certificates.crt:/ca.crt:ro \
  --tmpfs /state debian:trixie bash /e2e/run.sh
```

The scenarios:

1. An offline setup installs from the verified bundled packages, honouring a policy that restricts one app and blocks another.
2. Running it again changes nothing: every app reports already installed.
3. An allowed third-party app is queued while offline.
4. Back online, the queue drains through signed APT.
5. A tampered bundled package is refused and never reaches apt.
6. An unresolvable package fails once, with its reason, and doesn't fail setup.
7. The resulting system is checked: package states, missing libraries and desktop entries.
