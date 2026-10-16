"""Greeter logic: greetd IPC framing, domain name formats, password change, verification code (no GTK needed)."""
import hashlib
import json
import os
import socket
import struct
import tempfile
import threading
import unittest
from collections import namedtuple

from worksuite_greeter import login
from worksuite_greeter.greetd import Greetd

Pw = namedtuple("Pw", "pw_name pw_uid pw_gecos pw_shell")
CFG = {"domain": "corp.example", "netbios_domain": "CORP", "upn_suffixes": ["corp.example", "eu.corp.example"]}


def nobody(_name):
    raise KeyError(_name)


class FakeGreetd:
    """Scripted greetd: one secret prompt; accepts `good`, or for `expired`, only the change frame."""

    def __init__(self, good="pw", info=None, extra_secret=False):
        self.good, self.info, self.extra_secret = good, info, extra_secret
        self.log, self.secrets, self.started = [], [], None
        self.stage = 0

    def create_session(self, username):
        self.log.append(("create", username))
        if self.info:
            self.stage = -1
            return {"type": "auth_message", "auth_message_type": "info", "auth_message": self.info}
        return {"type": "auth_message", "auth_message_type": "secret", "auth_message": "Password: "}

    def respond(self, response):
        if self.stage == -1:
            self.stage = 0
            return {"type": "auth_message", "auth_message_type": "secret", "auth_message": "Password: "}
        self.secrets.append(response)
        if self.extra_secret and len(self.secrets) == 1:
            return {"type": "auth_message", "auth_message_type": "secret", "auth_message": "Other: "}
        if response == self.good:
            return {"type": "success"}
        return {"type": "error", "error_type": "auth_error", "description": "pam"}

    def start_session(self, cmd, env=()):
        self.started = cmd
        return {"type": "success"}

    def cancel_session(self):
        self.log.append(("cancel",))
        return {"type": "success"}


class NameTests(unittest.TestCase):
    def test_formats(self):
        n = lambda raw, sfx=None: login.normalize(raw, CFG, sfx, getpwnam=nobody)  # noqa: E731
        self.assertEqual(n("Ana@Corp.Example"), "ana@corp.example")
        self.assertEqual(n("CORP\\Ana"), "ana@corp.example")
        self.assertEqual(n("corp\\ana"), "ana@corp.example")
        self.assertEqual(n("ana"), "ana@corp.example")
        self.assertEqual(n("ana", "eu.corp.example"), "ana@eu.corp.example")
        self.assertEqual(n("ana@eu.corp.example"), "ana@eu.corp.example")
        for bad in ("OTHER\\ana", "ana@evil.example", ""):
            with self.assertRaises(login.NameError_):
                n(bad)
        with self.assertRaises(login.NameError_):
            n("ana", "evil.example")

    def test_local_accounts_win_and_unjoined_devices_keep_plain_names(self):
        local = lambda name: Pw(name, 1000, "", "/bin/bash")  # noqa: E731
        self.assertEqual(login.normalize("hasarinda", CFG, getpwnam=local), "hasarinda")
        self.assertEqual(login.normalize("ana", {}, getpwnam=nobody), "ana")
        with self.assertRaises(login.NameError_):
            login.normalize("CORP\\ana", {}, getpwnam=nobody)

    def test_domain_label(self):
        self.assertEqual(login.domain_label(CFG), "CORP (corp.example)")
        self.assertEqual(login.domain_label({"domain": "x.example"}), "x.example")
        self.assertIsNone(login.domain_label({}))

    def test_users_are_real_accounts_only(self):
        rows = [Pw("root", 0, "", "/bin/bash"), Pw("_greetd", 120, "", "/usr/sbin/nologin"), Pw("nimali", 1001, "Nimali,,,", "/bin/bash"),
                Pw("svc", 1002, "", "/usr/sbin/nologin"), Pw("wsadmin", 1003, "", "/bin/bash"), Pw("ana@corp.example", 200042, "Ana Silva", "/bin/bash")]
        self.assertEqual(login.users(lambda: rows), [
            {"name": "ana@corp.example", "display": "Ana Silva", "directory": True},
            {"name": "nimali", "display": "Nimali", "directory": False},
        ])


class SignInTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def mark(self, name, status):
        os.makedirs(os.path.join(self.run, "greeter"), exist_ok=True)
        with open(os.path.join(self.run, "greeter", hashlib.sha256(name.encode()).hexdigest()), "w") as f:
            f.write(status)

    def test_success_starts_the_worksuite_session(self):
        g = FakeGreetd(info="Welcome")
        r = login.sign_in(g, "ana@corp.example", "pw", run_dir=self.run)
        self.assertTrue(r.ok)
        self.assertEqual(g.started, ["/usr/bin/worksuite-session"])
        self.assertEqual(r.messages, ["Welcome"])

    def test_wrong_password_cancels(self):
        g = FakeGreetd()
        r = login.sign_in(g, "ana", "nope", run_dir=self.run)
        self.assertEqual((r.ok, r.reason), (False, "denied"))
        self.assertIn(("cancel",), g.log)
        self.assertIsNone(g.started)

    def test_expired_password_is_reported_and_changed_with_the_frame(self):
        self.mark("ana@corp.example", "expired")
        g = FakeGreetd(good=login.CHANGE_PREFIX + "old" + login.SEP + "new-password-1")
        self.assertEqual(login.sign_in(g, "ana@corp.example", "old", run_dir=self.run).reason, "expired")
        r = login.sign_in(g, "ana@corp.example", "old", new_password="new-password-1", run_dir=self.run)
        self.assertTrue(r.ok)

    def test_verification_code_follows_the_password(self):
        self.mark("ana@corp.example", "mfa")
        g = FakeGreetd(good="pw123456")
        self.assertEqual(login.sign_in(g, "ana@corp.example", "pw", run_dir=self.run).reason, "mfa")
        self.assertEqual(login.sign_in(g, "ana@corp.example", "pw", otp="12x456", run_dir=self.run).reason, "bad_code")
        self.assertTrue(login.sign_in(g, "ana@corp.example", "pw", otp="123456", run_dir=self.run).ok)

    def test_a_second_secret_prompt_is_not_answered_with_the_password(self):
        g = FakeGreetd(extra_secret=True)
        r = login.sign_in(g, "ana", "pw", run_dir=self.run)
        self.assertFalse(r.ok)
        self.assertEqual(g.secrets, ["pw"])

    def test_config_file(self):
        self.assertEqual(login.load_config(self.run), {})
        with open(os.path.join(self.run, "greeter.json"), "w") as f:
            json.dump(CFG, f)
        self.assertEqual(login.load_config(self.run), CFG)


class KeyGreetd(FakeGreetd):
    """pam_u2f first: an info cue, then success on touch, or a password prompt when no key answered."""

    def __init__(self, touched):
        super().__init__()
        self.touched = touched

    def create_session(self, username):
        self.log.append(("create", username))
        return {"type": "auth_message", "auth_message_type": "info", "auth_message": "Please touch the device."}

    def respond(self, response):
        self.secrets.append(response)
        if self.touched:
            return {"type": "success"}
        return {"type": "auth_message", "auth_message_type": "secret", "auth_message": "Password: "}


class MethodTests(unittest.TestCase):
    def test_methods_index(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "methods.json")
            self.assertEqual(login.signin_methods("alex", p), {"pin": False, "key": False, "default": "password"})
            with open(p, "w") as f:
                json.dump({"users": {"alex": {"pin": True, "keys": [{"id": "a"}], "default": "key"},
                                     "sam": {"pin": False, "keys": [], "default": "pin"}}}, f)
            self.assertEqual(login.signin_methods("alex", p), {"pin": True, "key": True, "default": "key"})
            self.assertEqual(login.available_methods(login.signin_methods("alex", p)), ["password", "pin", "key"])
            # a default the account no longer has falls back to the password
            self.assertEqual(login.signin_methods("sam", p)["default"], "password")
            self.assertEqual(login.available_methods(login.signin_methods("sam", p)), ["password"])

    def test_pin_goes_where_the_password_goes(self):
        g = FakeGreetd(good="582947")
        r = login.sign_in(g, "alex", "582947", method="pin", otp="123456")
        self.assertTrue(r.ok)
        self.assertEqual(g.secrets, ["582947"])  # no code appended to a PIN

    def test_pin_shape_is_checked_before_pam(self):
        g = FakeGreetd()
        for bad in ("", "123", "12ab56", "1234567890123"):
            self.assertEqual(login.sign_in(g, "alex", bad, method="pin").reason, "bad_pin")
        self.assertEqual(g.log, [])

    def test_security_key_sends_no_secret(self):
        g = KeyGreetd(touched=True)
        r = login.sign_in(g, "alex", "", method="key")
        self.assertTrue(r.ok)
        self.assertEqual(r.messages, ["Please touch the device."])
        self.assertEqual(g.secrets, [None])
        g = KeyGreetd(touched=False)
        r = login.sign_in(g, "alex", "typed-by-mistake", method="key")
        self.assertEqual(r.reason, "key_failed")
        self.assertNotIn("typed-by-mistake", g.secrets)
        self.assertIn(("cancel",), g.log)


class IpcTests(unittest.TestCase):
    def test_length_prefixed_json(self):
        a, b = socket.socketpair()
        got = []

        def server():
            (n,) = struct.unpack("=I", b.recv(4))
            got.append(json.loads(b.recv(n)))
            out = json.dumps({"type": "auth_message", "auth_message_type": "secret", "auth_message": "Password:"}).encode()
            b.sendall(struct.pack("=I", len(out)) + out)

        t = threading.Thread(target=server)
        t.start()
        r = Greetd(sock=a).create_session("ana")
        t.join()
        self.assertEqual(got, [{"type": "create_session", "username": "ana"}])
        self.assertEqual(r["auth_message_type"], "secret")
        a.close()
        b.close()


if __name__ == "__main__":
    unittest.main()


class G04Tests(unittest.TestCase):
    def test_reachability_uses_server_host(self):
        seen = []

        class Sock:
            def close(self):
                pass

        def ok(addr, timeout):
            seen.append(addr)
            return Sock()

        def down(addr, timeout):
            raise OSError("unreachable")

        self.assertIsNone(login.directory_reachable({}))
        self.assertTrue(login.directory_reachable({"server_host": "ws.corp.example"}, connect=ok))
        self.assertTrue(login.directory_reachable({"server_host": "ws.corp.example:8443"}, connect=ok))
        self.assertEqual(seen, [("ws.corp.example", 443), ("ws.corp.example", 8443)])
        self.assertFalse(login.directory_reachable({"server_host": "ws.corp.example"}, connect=down))

    def test_offline_days_left(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(login.offline_days_left("ana@corp.example", d))
            key = hashlib.sha256(b"ana@corp.example").hexdigest()
            with open(os.path.join(d, "offline.json"), "w") as f:
                json.dump({key: (1000 + 6.5 * 86400) * 1000}, f)
            self.assertEqual(login.offline_days_left("ana@corp.example", d, now=1000), 6)
            self.assertEqual(login.offline_days_left("ana@corp.example", d, now=1000 + 30 * 86400), 0)
            self.assertIsNone(login.offline_days_left("bob@corp.example", d))

    def test_break_glass_reason(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(login.save_break_glass_reason("  ", d))
            self.assertTrue(login.save_break_glass_reason("Directory down,\n restoring   network", d))
            with open(os.path.join(d, "reason")) as f:
                self.assertEqual(f.read(), "Directory down, restoring network")

    def test_initials_and_org(self):
        self.assertEqual(login.initials("Alex Perera"), "AP")
        self.assertEqual(login.initials(""), "?")
        self.assertEqual(login.org_name({"org_name": " Lanka Tea "}), "Lanka Tea")
        self.assertIsNone(login.org_name({}))
