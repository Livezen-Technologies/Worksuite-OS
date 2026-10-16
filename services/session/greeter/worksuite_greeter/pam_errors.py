"""PAM outcome -> a friendly message key for the greeter (no GTK, unit tested).

PAM modules talk to the greeter through greetd's conversation: pam_faillock ("The account is locked due to 5 failed
logins." / "(9 minutes left to unlock)"), pam_unix ("Your account has expired; please contact your system
administrator.", "You are required to change your password immediately (administrator enforced)."), pam_nologin (the
text of /etc/nologin), pam_access/pam_time, the WorkSuite directory helper, and so on. That text is technical, English
only and sometimes names files: people never see it. classify() maps it to one of KEYS (with numbers such as the
minutes left), the greeter shows its translated sentence, and the raw text goes to the journal only (journal_line()).
"""
import re

# Keys the greeter has a sentence for (ui.ERRORS). Order of the rules below matters: the first match wins.
KEYS = ("denied", "locked", "locked_admin", "account_expired", "expired", "weak", "not_allowed", "nologin",
        "offline_expired", "no_network", "error")

_LOCKED = re.compile(r"account is (temporarily )?locked|account locked|too many (failed|authentication) (logins|attempts|failures)", re.I)
_MINUTES = re.compile(r"\((\d+) minutes? left to unlock\)|(\d+) minutes? left", re.I)
_SECONDS = re.compile(r"(\d+) seconds? left", re.I)
_ACCOUNT_EXPIRED = re.compile(r"account (has )?expired|account is expired", re.I)
_PW_EXPIRED = re.compile(r"password (has )?expired|change your password (immediately|now)|password aged|must change your password|authentication token is no longer valid", re.I)
_WEAK = re.compile(r"BAD PASSWORD|password (is )?too (short|simple|similar)|fails the dictionary check|password unchanged|have exhausted maximum number of retries", re.I)
_NOT_ALLOWED = re.compile(r"not allowed to (log ?in|access|sign in)|access denied|permission denied|outside of allowed|not permitted|login refused", re.I)
_OFFLINE = re.compile(r"offline (sign-in|access|period)|offline-access", re.I)
_NOLOGIN = re.compile(r"system is (booting|going down|shutting down)|logins? (are|is) (currently )?(not allowed|disabled)|nologin", re.I)
_NETWORK = re.compile(r"cannot reach|can't reach|could not (contact|connect|reach)|unreachable|network (is )?(down|unreachable)|no route to host|timed out|authentication service cannot retrieve|cannot contact|connection refused|offline", re.I)


def classify(reason, messages=(), directory=False):
    """(key, params) for a failed sign-in.

    reason: login.Result.reason ('denied', 'error', 'expired', ...); messages: the info/error texts PAM sent during the
    conversation; directory: the account is a directory account (network trouble is only meaningful then).
    """
    text = "\n".join(m for m in messages if isinstance(m, str))
    if _LOCKED.search(text):
        m = _MINUTES.search(text)
        if m:
            return "locked", {"minutes": max(1, int(m.group(1) or m.group(2)))}
        s = _SECONDS.search(text)
        if s:
            return "locked", {"minutes": max(1, (int(s.group(1)) + 59) // 60)}
        return "locked_admin", {}
    if _ACCOUNT_EXPIRED.search(text):
        return "account_expired", {}
    if reason == "weak" or _WEAK.search(text):
        return "weak", {}
    if reason == "expired" or _PW_EXPIRED.search(text):
        return "expired", {}
    if _OFFLINE.search(text):
        return "offline_expired", {}
    if _NOLOGIN.search(text):
        return "nologin", {}
    if _NOT_ALLOWED.search(text):
        return "not_allowed", {}
    if directory and (reason == "error" or _NETWORK.search(text)):
        return "no_network", {}
    if reason in KEYS:
        return reason, {}
    return ("denied" if reason == "denied" else "error"), {}


def journal_line(name, reason, messages=()):
    """One line for the journal (the greeter's stderr goes there through systemd-cat): never the secret."""
    raw = " | ".join(" ".join(str(m).split()) for m in messages if m)
    return f"worksuite-greeter: sign-in failed for {name!r}: reason={reason}" + (f"; pam: {raw}" if raw else "")
