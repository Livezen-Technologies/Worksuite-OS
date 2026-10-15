# WorkSuite OS installer job (SRS §9.4, WSOS-INS-004, WSOS-SEC-009).
# For an encrypted install, generate one recovery key, add it as a second key slot on every LUKS partition the
# partition module created (unlocked with the user's passphrase), and leave it in global storage for the
# worksuiteconfirm@recovery page, which shows it once and then removes it. The key is never written to the target.
import os
import secrets
import subprocess
import tempfile

import libcalamares

GS_KEY = "worksuiteRecoveryKey"
# Crockford base32 without I, L, O, U: easy to read back and type at the unlock prompt.
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
# tmpfs, so the passphrase and key files never reach a disk. Tests running as a normal user point this elsewhere.
SECRET_DIR = "/run"


def pretty_name():
    return "Creating the disk recovery key"


def make_key(groups=8, size=5):
    """8 groups of 5 base32 characters: 200 bits, e.g. 7K2QF-…"""
    return "-".join("".join(secrets.choice(ALPHABET) for _ in range(size)) for _ in range(groups))


def encrypted_partitions(partitions):
    """Partitions the partition module encrypted, each once, with their passphrase."""
    seen = set()
    for p in partitions or []:
        dev, phrase = p.get("device"), p.get("luksPassphrase")
        if dev and phrase and dev not in seen:
            seen.add(dev)
            yield dev, phrase


def add_key(device, passphrase, key, run=subprocess.run):
    """cryptsetup luksAddKey with both secrets in 0600 files on tmpfs (never on the command line)."""
    with tempfile.TemporaryDirectory(dir=SECRET_DIR if os.path.isdir(SECRET_DIR) else None) as d:
        old, new = os.path.join(d, "old"), os.path.join(d, "new")
        for path, value in ((old, passphrase), (new, key)):
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(value)   # no trailing newline: the key file must equal what is typed at unlock
        r = run(["cryptsetup", "luksAddKey", "--batch-mode", "--key-file", old, device, new],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return r.returncode, (r.stderr or "").strip()


def run():
    targets = list(encrypted_partitions(libcalamares.globalstorage.value("partitions")))
    if not targets:
        return None                      # unencrypted install: the recovery page skips itself
    key = make_key()
    for device, passphrase in targets:
        code, err = add_key(device, passphrase, key)
        if code != 0:
            return ("Could not create the recovery key",
                    f"cryptsetup failed on {device}: {err or 'exit ' + str(code)}")
        libcalamares.utils.debug(f"recovery key slot added on {device}")
    libcalamares.globalstorage.insert(GS_KEY, key)
    return None
