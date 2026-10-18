# WorkSuite OS installer job: records which terms were accepted, and when, on the installed system.
#   global storage "worksuiteTerms"           {"version": …, "acceptedAt": …}, set by the worksuiteconfirm@terms page
#   <target>/var/lib/worksuite/terms-accepted  0644, "version=…" and "accepted=…" lines; no personal data
import os
import re

import libcalamares

KEY = "worksuiteTerms"
TARGET = "var/lib/worksuite/terms-accepted"
VERSION = re.compile(r"^[A-Za-z0-9._+~-]{1,64}$")
STAMP = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ?$")


def pretty_name():
    return "Recording the accepted terms"


def record(rec):
    """The file's text for a page record; None when the record is missing or malformed."""
    if not isinstance(rec, dict):
        return None
    v, at = rec.get("version"), rec.get("acceptedAt")
    if not (isinstance(v, str) and VERSION.match(v) and isinstance(at, str) and STAMP.match(at)):
        return None
    return "version={}\naccepted={}\n".format(v, at)


def run():
    text = record(libcalamares.globalstorage.value(KEY))
    if text is None:
        # The page keeps Install disabled until the terms are accepted: no record means a broken sequence.
        return ("The terms were not accepted", "worksuiteterms: no valid acceptance in global storage")
    root = libcalamares.globalstorage.value("rootMountPoint")
    if not root or not os.path.isdir(root):
        return ("No target system", "worksuiteterms: rootMountPoint is not set")
    path = os.path.join(root, TARGET)
    os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    libcalamares.utils.debug("worksuiteterms: terms acceptance recorded")
    return None
