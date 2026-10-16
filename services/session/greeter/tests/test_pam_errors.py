"""PAM outcomes become friendly message keys; raw PAM text only goes to the journal line. Local expired passwords are
changed in the same conversation; user tiles come from real accounts and AccountsService."""
import os
import tempfile
import unittest
from collections import namedtuple

from worksuite_greeter import login, pam_errors

Pw = namedtuple("Pw", "pw_name pw_uid pw_gecos pw_shell")


class ClassifyTest(unittest.TestCase):
    def test_wrong_password(self):
        self.assertEqual(pam_errors.classify("denied", []), ("denied", {}))

    def test_faillock_minutes_left(self):
        msgs = ["The account is locked due to 5 failed logins.", "(9 minutes left to unlock)"]
        self.assertEqual(pam_errors.classify("denied", msgs), ("locked", {"minutes": 9}))

    def test_faillock_seconds_round_up_to_a_minute(self):
        self.assertEqual(pam_errors.classify("denied", ["The account is locked due to 3 failed logins.", "(30 seconds left to unlock)"]),
                         ("locked", {"minutes": 1}))

    def test_faillock_without_unlock_time_needs_an_admin(self):
        self.assertEqual(pam_errors.classify("denied", ["The account is locked due to 5 failed logins."]), ("locked_admin", {}))

    def test_account_expired_wins_over_password_expired(self):
        self.assertEqual(pam_errors.classify("denied", ["Your account has expired; please contact your system administrator."]),
                         ("account_expired", {}))

    def test_password_expired(self):
        self.assertEqual(pam_errors.classify("denied", ["You are required to change your password immediately (administrator enforced)."]),
                         ("expired", {}))
        self.assertEqual(pam_errors.classify("expired", []), ("expired", {}))

    def test_weak_new_password(self):
        self.assertEqual(pam_errors.classify("weak", ["BAD PASSWORD: The password is shorter than 8 characters"]), ("weak", {}))

    def test_nologin_and_offline_period(self):
        self.assertEqual(pam_errors.classify("denied", ["System is booting up. Unprivileged users are not permitted to log in yet."]),
                         ("nologin", {}))
        self.assertEqual(pam_errors.classify("denied", ["Offline sign-in period has ended for this device."]), ("offline_expired", {}))

    def test_not_allowed(self):
        self.assertEqual(pam_errors.classify("denied", ["Access denied"]), ("not_allowed", {}))

    def test_network_trouble_only_for_directory_accounts(self):
        msgs = ["Authentication service cannot retrieve authentication info"]
        self.assertEqual(pam_errors.classify("error", msgs, directory=True), ("no_network", {}))
        self.assertEqual(pam_errors.classify("error", [], directory=True), ("no_network", {}))
        self.assertEqual(pam_errors.classify("error", msgs, directory=False), ("error", {}))

    def test_unknown_reason_is_generic(self):
        self.assertEqual(pam_errors.classify("something-new", ["pam_foo: ???"]), ("error", {}))

    def test_every_key_is_known(self):
        for reason, msgs in [("denied", []), ("error", []), ("expired", []), ("weak", []), ("denied", ["Access denied"])]:
            self.assertIn(pam_errors.classify(reason, msgs)[0], pam_errors.KEYS)

    def test_journal_line_has_the_raw_text_but_not_the_secret(self):
        line = pam_errors.journal_line("nimali", "denied", ["The account is locked due to 5 failed logins.", "(9 minutes left to unlock)"])
        self.assertIn("locked due to 5 failed logins", line)
        self.assertIn("'nimali'", line)


class ChauthtokGreetd:
    """greetd running pam_unix for an expired local password: Password, then current/new/retype."""

    def __init__(self, weak=False):
        self.weak, self.sent, self.started, self.cancelled = weak, [], None, False
        self.queue = [
            {"type": "auth_message", "auth_message_type": "info", "auth_message": "You are required to change your password immediately (administrator enforced)."},
            {"type": "auth_message", "auth_message_type": "secret", "auth_message": "Current password: "},
            {"type": "auth_message", "auth_message_type": "secret", "auth_message": "New password: "},
            {"type": "auth_message", "auth_message_type": "secret", "auth_message": "Retype new password: "},
        ]
        if weak:
            self.queue += [
                {"type": "auth_message", "auth_message_type": "error", "auth_message": "BAD PASSWORD: it is too short"},
                {"type": "auth_message", "auth_message_type": "secret", "auth_message": "New password: "},
            ]
        self.queue.append({"type": "success"})

    def create_session(self, username):
        return {"type": "auth_message", "auth_message_type": "secret", "auth_message": "Password: "}

    def respond(self, response):
        self.sent.append(response)
        return self.queue.pop(0)

    def start_session(self, cmd, env=()):
        self.started = cmd
        return {"type": "success"}

    def cancel_session(self):
        self.cancelled = True
        return {"type": "success"}


def local_pw(name):
    return Pw(name, 1001, "", "/bin/bash")


class LocalExpiryTest(unittest.TestCase):
    def test_expired_local_password_asks_for_a_new_one(self):
        g = ChauthtokGreetd()
        r = login.sign_in(g, "nimali", "old", getpwnam=local_pw)
        self.assertEqual(r.reason, "expired")
        self.assertTrue(g.cancelled)
        self.assertEqual(g.sent, ["old", None])  # the password, then the acknowledgement of the info message

    def test_changed_in_the_same_conversation_without_the_directory_frame(self):
        g = ChauthtokGreetd()
        r = login.sign_in(g, "nimali", "old", new_password="new-password-1", getpwnam=local_pw)
        self.assertTrue(r.ok)
        self.assertEqual(g.sent[:4], ["old", None, "old", "new-password-1"])
        self.assertEqual(g.sent[4], "new-password-1")
        self.assertNotIn(login.CHANGE_PREFIX, "".join(s for s in g.sent if s))

    def test_policy_refusal_is_weak(self):
        g = ChauthtokGreetd(weak=True)
        r = login.sign_in(g, "nimali", "old", new_password="short1", getpwnam=local_pw)
        self.assertEqual(r.reason, "weak")
        self.assertIn("BAD PASSWORD: it is too short", r.messages)
        self.assertEqual(pam_errors.classify(r.reason, r.messages), ("weak", {}))

    def test_directory_accounts_are_not_local(self):
        self.assertFalse(login.is_local("ana@corp.example"))
        self.assertFalse(login.is_local("ana", getpwnam=lambda n: Pw(n, 200042, "", "/bin/bash")))
        self.assertTrue(login.is_local("nimali", getpwnam=local_pw))


class TilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        os.makedirs(os.path.join(d, "users"))
        os.makedirs(os.path.join(d, "icons"))
        with open(os.path.join(d, "users", "nimali"), "w") as f:
            f.write("[User]\nRealName=Nimali Perera\nIcon=%s\n" % os.path.join(d, "icons", "nimali"))
        with open(os.path.join(d, "icons", "nimali"), "wb") as f:
            f.write(b"\x89PNG")
        with open(os.path.join(d, "users", "builder"), "w") as f:
            f.write("[User]\nSystemAccount=true\n")
        self.dir = d

    def tearDown(self):
        self.tmp.cleanup()

    def test_people_only_with_real_names_and_pictures(self):
        rows = [Pw("root", 0, "", "/bin/bash"), Pw("nimali", 1001, "Nimali,,,", "/bin/bash"), Pw("builder", 1002, "", "/bin/bash"),
                Pw("kamal", 1003, "Kamal Silva", "/bin/bash"), Pw("svc", 1004, "", "/usr/sbin/nologin"),
                Pw("dyn", 61000, "", "/bin/bash"), Pw("ana@corp.example", 200042, "Ana Silva", "/bin/bash")]
        tiles = login.user_tiles(login.users(lambda: rows), accounts_dir=self.dir)
        self.assertEqual([t["name"] for t in tiles], ["ana@corp.example", "kamal", "nimali"])
        nimali = tiles[2]
        self.assertEqual((nimali["display"], nimali["initials"]), ("Nimali Perera", "NP"))
        self.assertTrue(nimali["icon"].endswith("icons/nimali"))
        self.assertIsNone(tiles[1]["icon"])
        self.assertTrue(tiles[0]["directory"])

    def test_last_user_first(self):
        rows = [Pw("nimali", 1001, "Nimali", "/bin/bash"), Pw("kamal", 1003, "Kamal", "/bin/bash")]
        tiles = login.user_tiles(login.users(lambda: rows), accounts_dir=self.dir, last="nimali")
        self.assertEqual(tiles[0]["name"], "nimali")

    def test_last_user_round_trip(self):
        p = os.path.join(self.dir, "last")
        self.assertIsNone(login.read_last_user(p))
        login.save_last_user("kamal", p)
        self.assertEqual(login.read_last_user(p), "kamal")


if __name__ == "__main__":
    unittest.main()
