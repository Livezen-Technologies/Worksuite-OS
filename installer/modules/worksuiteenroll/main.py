# WorkSuite OS installer job (WSOS-INS-006): hands the enrollment from the installer page to the installed system.
#   /run/worksuite-installer-enroll.json   written by the worksuiteconfirm@enroll page (root, 0600)
#   <target>/var/lib/worksuite-device-agent/enroll-pending.json   0600 root in a 0700 directory; the device agent
#                                                                  enrolls with it on first boot, then deletes it
# The token is never logged, and the live-session copy is removed whatever happens.
import json
import os
import re

import libcalamares

SOURCE = "/run/worksuite-installer-enroll.json"
TARGET_DIR = "var/lib/worksuite-device-agent"
TARGET_NAME = "enroll-pending.json"
TOKEN = re.compile(r"^[A-Za-z0-9_.~-]{8,512}$")
SERVER = re.compile(r"^https://[A-Za-z0-9.-]+(:\d{1,5})?/[^\s?#]*$")


def pretty_name():
    return "Saving the device enrollment"


def valid(d):
    return isinstance(d, dict) and set(d) == {"server", "enrollment_token"} \
        and isinstance(d["server"], str) and SERVER.match(d["server"]) is not None \
        and isinstance(d["enrollment_token"], str) and TOKEN.match(d["enrollment_token"]) is not None


def write_private(path, data):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, "w") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(data)


def run(source=SOURCE):
    if not os.path.lexists(source):
        return None
    try:
        st = os.lstat(source)
        if not os.path.isfile(source) or os.path.islink(source) or st.st_uid != os.getuid() or st.st_mode & 0o077:
            libcalamares.utils.debug("worksuiteenroll: pending enrollment file has the wrong owner or mode; skipped")
            return None
        with open(source) as f:
            data = json.load(f)
        if not valid(data):
            libcalamares.utils.debug("worksuiteenroll: pending enrollment is not valid; skipped")
            return None
        root = libcalamares.globalstorage.value("rootMountPoint")
        if not root or not os.path.isdir(root):
            return ("No target system", "worksuiteenroll: rootMountPoint is not set")
        d = os.path.join(root, TARGET_DIR)
        os.makedirs(d, mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
        write_private(os.path.join(d, TARGET_NAME), json.dumps(data))
        libcalamares.utils.debug("worksuiteenroll: enrollment saved for first boot")
        return None
    except (OSError, ValueError) as e:
        # Optional step: the device can still be enrolled from Settings. No exception text (it could quote the file).
        libcalamares.utils.debug("worksuiteenroll: could not save the enrollment ({})".format(type(e).__name__))
        return None
    finally:
        try:
            os.unlink(source)
        except OSError:
            pass
