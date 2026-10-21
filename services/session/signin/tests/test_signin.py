"""Device PIN verifier, lockout, daemon peer rules, PAM/pkexec entry points and security-key mappings.

The PIN must never appear in argv, stdout/stderr or any file: every test that handles one checks that.
"""
import io
import json
import os
import pwd
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from collections import namedtuple
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from worksuite_signin import bus, cli, core  # noqa: E402

core.SCRYPT = {"n": 1 << 10, "r": 8, "p": 1}  # fast in tests; the shipped cost is checked below
PIN = "582947"
POL = {"allow_pin": True, "pin_min_length": 6, "attempt_limit": 3}
Pw = namedtuple("Pw", "pw_name pw_uid")
USERS = {"alex": Pw("alex", 1000), "sam": Pw("sam", 1001)}


def getpwnam(name):
    return USERS[name]


def all_text(root):
    out = b""
    for p in Path(root).rglob("*"):
        if p.is_file():
            out += p.read_bytes()
    return out


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "state")
        self.run_dir = os.path.join(self.tmp.name, "run")

    def tearDown(self):
        self.tmp.cleanup()


class VerifierTests(Tmp):
    def test_shipped_cost(self):
        src = (HERE / "worksuite_signin" / "core.py").read_text()
        self.assertIn('SCRYPT = {"n": 1 << 15, "r": 8, "p": 1}', src)

    def test_only_a_salted_verifier_is_stored(self):
        core.set_pin(1000, PIN, POL, self.state)
        rec = core.read_pin(1000, self.state)
        self.assertEqual(rec["kdf"], "scrypt")
        self.assertNotIn(PIN.encode(), all_text(self.state))
        self.assertTrue(core.matches(rec, PIN))
        self.assertFalse(core.matches(rec, "582948"))
        other = core.make_verifier(PIN)
        self.assertNotEqual(other["salt"], rec["salt"])
        self.assertNotEqual(other["hash"], rec["hash"])

    def test_files_are_root_only(self):
        core.set_pin(1000, PIN, POL, self.state)
        self.assertEqual(stat.S_IMODE(os.stat(core.pin_path(1000, self.state)).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.state, "pin")).st_mode), 0o700)

    def test_new_pin_rules(self):
        for bad, code in (("12a456", "digits_only"), ("4821", "too_short"), ("1" * 13, "too_long"),
                          ("111111", "too_simple"), ("123456", "too_simple"), ("987654", "too_simple"), ("", "digits_only")):
            with self.assertRaises(core.SigninError) as e:
                core.set_pin(1000, bad, POL, self.state)
            self.assertEqual(e.exception.code, code, bad)
        with self.assertRaises(core.SigninError) as e:
            core.set_pin(1000, PIN, {**POL, "allow_pin": False}, self.state)
        self.assertEqual(e.exception.code, "pin_disabled")
        core.set_pin(1000, "4821", {**POL, "pin_min_length": 4}, self.state)

    def test_policy_and_attempt_limit_follow_faillock(self):
        pol = os.path.join(self.tmp.name, "signin-policy.conf")
        fl = os.path.join(self.tmp.name, "faillock.conf")
        Path(fl).write_text("deny = 5\n")
        self.assertEqual(core.policy(pol, fl), {"allow_pin": True, "pin_min_length": 6, "pin_max_length": 6, "attempt_limit": 3})
        Path(pol).write_text("ALLOW_PIN=0\nPIN_MIN_LENGTH=8\n")
        Path(fl).write_text("deny = 3\n")
        self.assertEqual(core.policy(pol, fl), {"allow_pin": False, "pin_min_length": 8, "pin_max_length": 8, "attempt_limit": 1})
        Path(pol).write_text("PIN_MIN_LENGTH=2\n")
        Path(fl).write_text("deny = 20\n")
        self.assertEqual(core.policy(pol, fl), {"allow_pin": True, "pin_min_length": 4, "pin_max_length": 4, "attempt_limit": 5})
        Path(pol).write_text("PIN_MIN_LENGTH=6\nPIN_MAX_LENGTH=99\n")
        self.assertEqual(core.policy(pol, fl)["pin_max_length"], 12)

    def test_new_pin_is_exactly_the_policy_length(self):
        # #56: the field took a 7th digit and the helper then accepted 6-12; now one length, enforced by the helper.
        pol = {**POL, "pin_max_length": 6}
        with self.assertRaises(core.SigninError) as e:
            core.set_pin(1000, "5829471", pol, self.state)
        self.assertEqual(e.exception.code, "too_long")
        core.set_pin(1000, PIN, pol, self.state)
        rec = core.read_pin(1000, self.state)
        self.assertNotIn(PIN.encode(), all_text(self.state))
        self.assertEqual(rec["kdf"], "scrypt")
        self.assertEqual(core.verify_pin(1000, PIN, {**pol, "attempt_limit": 3}, self.state, self.run_dir), "ok")


class LockoutTests(Tmp):
    def v(self, pin, uid=1000, pol=POL):
        return core.verify_pin(uid, pin, pol, self.state, self.run_dir)

    def test_wrong_pins_lock_the_pin_until_reset(self):
        core.set_pin(1000, PIN, POL, self.state)
        self.assertEqual(self.v("000001"), "wrong")
        self.assertEqual(self.v("000002"), "wrong")
        self.assertEqual(self.v("000003"), "locked")
        self.assertEqual(self.v(PIN), "locked")  # the right PIN no longer works: password required
        self.assertEqual(core.tries_left(1000, POL, self.state), 0)
        core.reset_failures(1000, self.state)
        self.assertEqual(self.v(PIN), "ok")

    def test_success_clears_the_count(self):
        core.set_pin(1000, PIN, POL, self.state)
        self.v("000001")
        self.assertEqual(self.v(PIN), "ok")
        self.assertEqual(core.tries_left(1000, POL, self.state), 3)

    def test_passwords_are_not_pin_tries(self):
        core.set_pin(1000, PIN, POL, self.state)
        for pw in ("correct horse", "abc123", "12", "1234567890123", "５８２９４７"):
            self.assertEqual(self.v(pw), "not_pin")
        self.assertEqual(core.tries_left(1000, POL, self.state), 3)

    def test_policy_off_and_no_pin(self):
        self.assertEqual(self.v(PIN), "no_pin")
        core.set_pin(1000, PIN, POL, self.state)
        self.assertEqual(self.v(PIN, pol={**POL, "allow_pin": False}), "disabled")

    def test_pin_used_marker_is_one_shot(self):
        core.set_pin(1000, PIN, POL, self.state)
        self.assertFalse(core.consume_pin_used(1000, self.run_dir))
        self.v(PIN)
        self.assertTrue(core.consume_pin_used(1000, self.run_dir))
        self.assertFalse(core.consume_pin_used(1000, self.run_dir))


class DaemonTests(Tmp):
    def h(self, req, peer):
        return cli.handle(req, peer, getpwnam, self.state, self.run_dir, POL)

    def test_callers_only_reach_their_own_account(self):
        core.set_pin(1000, PIN, POL, self.state)
        self.assertEqual(self.h({"op": "verify", "user": "alex", "pin": PIN}, 1001), {"ok": False, "error": "not_allowed"})
        self.assertEqual(self.h({"op": "verify", "user": "alex", "pin": PIN}, 1000)["ok"], True)
        self.assertEqual(self.h({"op": "verify", "user": "alex", "pin": PIN}, 0)["ok"], True)
        self.assertEqual(self.h({"op": "verify", "user": "nobody-here", "pin": PIN}, 0)["error"], "no_user")

    def test_only_root_resets_the_count(self):
        core.set_pin(1000, PIN, POL, self.state)
        for _ in range(3):
            self.h({"op": "verify", "user": "alex", "pin": "000001"}, 1000)
        self.assertEqual(self.h({"op": "reset", "user": "alex"}, 1000), {"ok": False, "error": "not_allowed"})
        self.assertEqual(self.h({"op": "verify", "user": "alex", "pin": PIN}, 1000)["result"], "locked")
        self.assertTrue(self.h({"op": "reset", "user": "alex"}, 0)["ok"])
        self.assertEqual(self.h({"op": "verify", "user": "alex", "pin": PIN}, 1000)["result"], "ok")

    def test_replies_never_echo_the_pin(self):
        core.set_pin(1000, PIN, POL, self.state)
        for pin in (PIN, "000001"):
            self.assertNotIn(pin, json.dumps(self.h({"op": "verify", "user": "alex", "pin": pin}, 1000)))

    def test_default_method_needs_the_method(self):
        self.assertEqual(self.h({"op": "set_default", "user": "alex", "method": "pin"}, 1000)["error"], "not_set_up")
        core.update_user("alex", lambda u: u.__setitem__("pin", True), self.state)
        self.assertTrue(self.h({"op": "set_default", "user": "alex", "method": "pin"}, 1000)["ok"])
        self.assertEqual(core.read_methods(self.state)["users"]["alex"]["default"], "pin")
        self.assertEqual(self.h({"op": "set_default", "user": "alex", "method": "pin"}, 1001)["error"], "not_allowed")
        self.assertEqual(stat.S_IMODE(os.stat(core.methods_path(self.state)).st_mode), 0o644)

    def test_bad_requests(self):
        for req in (None, [], {"op": "verify"}, {"op": "x", "user": "alex"}, {"op": "verify", "user": "a" * 300}):
            self.assertFalse(self.h(req, 0)["ok"])


class SocketTests(Tmp):
    """The real daemon loop over a Unix socket: peer credentials come from the kernel, not the request."""

    def test_serve_uses_peer_credentials(self):
        me = pwd.getpwuid(os.getuid()).pw_name
        os.environ["WORKSUITE_SIGNIN_STATE"] = self.state
        core.set_pin(os.getuid(), PIN, POL, self.state)
        a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        self.assertEqual(cli.peer_uid(b), os.getuid())
        orig = cli.handle
        cli.handle = lambda req, peer: orig(req, peer, pwd.getpwnam, self.state, self.run_dir, POL)
        try:
            t = threading.Thread(target=cli.serve, args=(b,))
            t.start()
            a.sendall((json.dumps({"op": "verify", "user": me, "pin": PIN}) + "\n").encode())
            reply = json.loads(a.recv(4096).decode())
            t.join()
        finally:
            cli.handle = orig
            a.close()
        self.assertEqual(reply, {"ok": True, "result": "ok"})


class FakeDaemon:
    def __init__(self, path, answer):
        self.path, self.answer, self.got = path, answer, []
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(path)
        self.srv.listen(1)
        self.t = threading.Thread(target=self.loop, daemon=True)
        self.t.start()

    def loop(self):
        c, _ = self.srv.accept()
        self.got.append(json.loads(cli._read_line(c).decode()))
        c.sendall((json.dumps(self.answer) + "\n").encode())
        c.close()
        self.srv.close()


class PamTests(Tmp):
    def test_pam_pin_reads_stdin_and_asks_the_daemon(self):
        sock = os.path.join(self.tmp.name, "s")
        d = FakeDaemon(sock, {"ok": True, "result": "ok"})
        rc = cli.pam_pin({"PAM_USER": "alex", "PAM_TYPE": "auth"}, io.BytesIO(PIN.encode() + b"\0"), sock)
        d.t.join(2)
        self.assertEqual(rc, 0)
        self.assertEqual(d.got, [{"op": "verify", "user": "alex", "pin": PIN}])

    def test_wrong_or_password_shaped_secrets_fail_without_asking(self):
        sock = os.path.join(self.tmp.name, "s")
        d = FakeDaemon(sock, {"ok": False, "result": "wrong"})
        self.assertEqual(cli.pam_pin({"PAM_USER": "alex"}, io.BytesIO(b"000001\0"), sock), 1)
        d.t.join(2)
        # a password is never sent to the PIN daemon
        self.assertEqual(cli.pam_pin({"PAM_USER": "alex"}, io.BytesIO(b"hunter2 pass\0"), os.path.join(self.tmp.name, "none")), 1)
        self.assertEqual(cli.pam_pin({}, io.BytesIO(PIN.encode()), sock), 1)
        # daemon down: fail closed
        self.assertEqual(cli.pam_pin({"PAM_USER": "alex"}, io.BytesIO(PIN.encode()), os.path.join(self.tmp.name, "none")), 1)

    def test_password_and_not_applicable_answers_exit_zero(self):
        # pam_exec logs every non-zero exit at error level: the common case (a password) must answer 0.
        self.assertEqual(cli.pam_not_pin({"PAM_USER": "alex"}, io.BytesIO(b"hunter2 pass\0")), 0)
        self.assertEqual(cli.pam_not_pin({"PAM_USER": "alex"}, io.BytesIO(b"\0")), 0)
        self.assertEqual(cli.pam_not_pin({"PAM_USER": "alex"}, io.BytesIO(PIN.encode() + b"\0")), 1)
        none = os.path.join(self.tmp.name, "none")
        self.assertEqual(cli.pam_password_used({"PAM_USER": "alex"}, none), 0)  # daemon down: keyring still runs
        sock = os.path.join(self.tmp.name, "s")
        d = FakeDaemon(sock, {"ok": True})
        self.assertEqual(cli.pam_password_used({"PAM_USER": "alex"}, sock), 1)  # PIN used: skip the keyring
        d.t.join(2)
        env = {"PAM_USER": "alex", "WORKSUITE_SIGNIN_SOCK": none}
        self.assertEqual(cli.main(["pam-reset"], env, io.BytesIO(b"")), 0)

    def test_helper_process_prints_nothing_and_keeps_the_pin_out_of_argv(self):
        env = {**os.environ, "PAM_USER": "alex", "PAM_TYPE": "auth", "WORKSUITE_SIGNIN_SOCK": os.path.join(self.tmp.name, "none"),
               "PYTHONPATH": str(HERE)}
        argv = [sys.executable, "-m", "worksuite_signin", "pam-pin"]
        r = subprocess.run(argv, input=PIN.encode() + b"\0", capture_output=True, env=env, timeout=30)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout + r.stderr, b"")
        self.assertNotIn(PIN, " ".join(argv))

    def test_profiles_pass_the_pin_on_stdin_only(self):
        pam = HERE.parent / "pam"
        for f in ("worksuite-signin-pin", "worksuite-signin-pin-final", "worksuite-signin-u2f", "worksuite-keyring"):
            text = (pam / f).read_text()
            for line in text.splitlines():
                if "pam_exec" in line:
                    self.assertIn("quiet", line)
                    self.assertNotIn("log=", line)
                    self.assertNotIn("debug", line)
        self.assertIn("expose_authtok", (pam / "worksuite-signin-pin").read_text())
        self.assertNotIn("expose_authtok", (pam / "worksuite-keyring").read_text())


class ManageTests(Tmp):
    def setUp(self):
        super().setUp()
        self.calls = []
        self.maps = os.path.join(self.tmp.name, "u2f_mappings")
        os.environ["WORKSUITE_U2F_MAPPINGS"] = self.maps
        core.U2F_MAPPINGS = self.maps
        self.env = {"PKEXEC_UID": "1000"}
        self.me = "alex"

    def run_(self, argv, **kw):
        self.calls.append(list(argv))
        out = kw.pop("_out", "")
        return subprocess.CompletedProcess(argv, 0, out, "")

    def m(self, argv, stdin=b"", run=None):
        return cli.manage(argv, self.env, io.BytesIO(stdin), 0, run or self.run_, self.state, lambda uid: {1000: USERS["alex"], 0: Pw("root", 0)}[uid],
                          devices=lambda: ["hidraw3"])

    def test_only_pkexec_root_and_only_the_caller(self):
        with self.assertRaises(core.SigninError) as e:
            cli.manage(["pin-set"], self.env, io.BytesIO(PIN.encode()), 1000, self.run_, self.state)
        self.assertEqual(e.exception.code, "not_root")
        with self.assertRaises(core.SigninError) as e:
            cli.manage(["pin-set", "--user", "root"], {}, io.BytesIO(PIN.encode()), 0, self.run_, self.state)
        self.assertEqual(e.exception.code, "not_pkexec")

    def test_pin_set_and_remove_toggle_the_pam_profiles(self):
        old = core.POLICY_FILE
        core.POLICY_FILE = os.path.join(self.tmp.name, "none.conf")
        try:
            self.assertEqual(self.m(["pin-set"], PIN.encode() + b"\n"), {"ok": True})
        finally:
            core.POLICY_FILE = old
        self.assertTrue(core.read_methods(self.state)["users"][self.me]["pin"])
        self.assertEqual(self.calls[-1][1:], ["--enable", "worksuite-signin-pin", "worksuite-signin-pin-final"])
        self.assertNotIn(PIN, json.dumps(self.calls))
        self.m(["pin-remove"])
        self.assertNotIn(self.me, core.read_methods(self.state)["users"])
        self.assertEqual(self.calls[-1][1:], ["--disable", "worksuite-signin-pin", "worksuite-signin-pin-final"])
        self.assertIsNone(core.read_pin(1000, self.state))
        with self.assertRaises(core.SigninError) as e:
            cli.manage(["pin-remove"], {"PKEXEC_UID": "0"}, io.BytesIO(), 0, self.run_, self.state, lambda uid: Pw("root", 0))
        self.assertEqual(e.exception.code, "not_allowed")

    def test_main_prints_a_code_never_the_pin(self):
        out = io.StringIO()
        orig = sys.stdout
        sys.stdout = out
        try:
            rc = cli.main(["pin-set"], {"PKEXEC_UID": str(os.getuid())}, io.BytesIO(b"111111\n"))
        finally:
            sys.stdout = orig
        self.assertEqual(rc, 1)
        self.assertNotIn("111111", out.getvalue())
        self.assertIn('"ok": false', out.getvalue())

    def test_key_add_list_remove(self):
        cred = "Kh0nDlE+abc/def==,PubKeyBase64+/==,es256,+presence"
        run = lambda argv, **kw: self.run_(argv, _out=":" + cred + "\n")  # noqa: E731
        r = self.m(["key-add", "--name", "  YubiKey   5C "], run=run)
        self.assertTrue(r["ok"])
        add = next(c for c in self.calls if c[0].endswith("pamu2fcfg"))
        self.assertEqual(add[1:], ["-n", "-u", self.me, "-o", "pam://worksuite", "-i", "pam://worksuite"])
        self.assertEqual(Path(self.maps).read_text().splitlines()[-1], f"{self.me}:{cred}")
        self.assertEqual(stat.S_IMODE(os.stat(self.maps).st_mode), 0o644)
        keys = core.read_methods(self.state)["users"][self.me]["keys"]
        self.assertEqual([k["name"] for k in keys], ["YubiKey 5C"])
        self.assertEqual(self.calls[-1][1:], ["--enable", "worksuite-signin-u2f"])
        with self.assertRaises(core.SigninError):
            self.m(["key-add"], run=run)  # same key twice
        self.m(["key-remove", "--id", r["id"]])
        self.assertNotIn(self.me, Path(self.maps).read_text())
        self.assertEqual(self.calls[-1][1:], ["--disable", "worksuite-signin-u2f"])

    def test_key_add_explains_what_went_wrong(self):
        # #57: a missing key, a timeout, a key PIN and a missing pamu2fcfg each get their own message.
        with self.assertRaises(core.SigninError) as e:
            cli.manage(["key-add", "--name", "k"], self.env, io.BytesIO(), 0, self.run_, self.state,
                       lambda uid: USERS["alex"], devices=lambda: [])
        self.assertEqual(e.exception.code, "key_not_found")
        self.assertFalse(any(c[0].endswith("pamu2fcfg") for c in self.calls))
        for err, code in (("No device found. Aborting.", "key_not_found"),
                          ("error: fido_dev_make_cred (-8) FIDO_ERR_ACTION_TIMEOUT", "key_timeout"),
                          ("error: fido_dev_make_cred (54) FIDO_ERR_PIN_REQUIRED", "key_pin_required"),
                          ("error: fido_dev_make_cred (25) FIDO_ERR_CREDENTIAL_EXCLUDED", "key_exists"),
                          ("something else", "key_failed")):
            fail = lambda argv, err=err, **kw: subprocess.CompletedProcess(argv, 1, "", err)  # noqa: E731
            with self.assertRaises(core.SigninError) as e:
                self.m(["key-add", "--name", "k"], run=fail)
            self.assertEqual(e.exception.code, code, err)

        def slow(argv, **kw):
            raise subprocess.TimeoutExpired(argv, 90)

        def missing(argv, **kw):
            raise FileNotFoundError(argv[0])
        for r, code in ((slow, "key_timeout"), (missing, "key_unavailable")):
            with self.assertRaises(core.SigninError) as e:
                self.m(["key-add", "--name", "k"], run=r)
            self.assertEqual(e.exception.code, code)

    def test_removing_an_unknown_key_is_refused(self):
        with self.assertRaises(core.SigninError) as e:
            self.m(["key-remove", "--id", "0123456789abcdef"])
        self.assertEqual(e.exception.code, "key_unknown")
        with self.assertRaises(core.SigninError) as e:
            self.m(["key-remove", "--id", "ABC"])
        self.assertEqual(e.exception.code, "bad_request")

    def test_fido_devices_are_found_by_usage_page(self):
        root = os.path.join(self.tmp.name, "sys")
        for n, desc in (("hidraw0", b"\x05\x01\x09\x06"), ("hidraw1", b"\x06\xd0\xf1\x09\x01\xa1\x01")):
            d = os.path.join(root, "class", "hidraw", n, "device")
            os.makedirs(d)
            Path(d, "report_descriptor").write_bytes(desc)
        os.makedirs(os.path.join(root, "class", "hidraw", "hidraw2"))  # no descriptor: skipped
        self.assertEqual(core.fido_devices(root), ["hidraw1"])
        self.assertEqual(core.fido_devices(os.path.join(self.tmp.name, "nosys")), [])

    def test_bad_pamu2fcfg_output_is_refused(self):
        for out in ("", "user:a,b,es256,+presence", "garbage", ":a,b,es256,+presence:c,d,es256,"):
            with self.assertRaises(core.SigninError):
                core.parse_pamu2fcfg(out)


class DiskTests(unittest.TestCase):
    """The PIN never unlocks the LUKS disk: nothing in the boot path knows about it."""

    def test_no_pin_in_the_boot_path(self):
        repo = HERE.parent.parent.parent
        for d in ("installer", "services/recovery-boot", "live-build/config/hooks"):
            for p in (repo / d).rglob("*"):
                if p.is_file() and p.stat().st_size < 1_000_000:
                    t = p.read_text(errors="ignore")
                    self.assertNotIn("worksuite-signin", t, str(p))
                    self.assertNotIn("signin/pin", t, str(p))


if __name__ == "__main__":
    unittest.main()


class BusTests(ManageTests):
    """lk.worksuite.SignIn1 (WSOS-ARC-002): named methods, polkit per call, caller's UID from the bus only."""

    def d(self, member, args, uid=1000, allow=True, seen=None):
        async def authorized(action):
            (seen if seen is not None else []).append(action)
            return allow
        import asyncio
        return asyncio.run(bus.dispatch(member, args, uid, authorized, self.run_, self.state, lambda u: {1000: USERS["alex"], 0: Pw("root", 0)}[u]))

    def test_every_method_needs_the_signin_action(self):
        self.assertEqual(set(bus.ACTIONS), {"SetPin", "RemovePin", "AddKey", "RemoveKey"})
        self.assertEqual(set(bus.ACTIONS.values()), {"lk.worksuite.signin.manage"})
        seen = []
        with self.assertRaises(bus.NotAuthorized):
            self.d("SetPin", [PIN], allow=False, seen=seen)
        self.assertEqual(seen, ["lk.worksuite.signin.manage"])
        self.assertNotIn(self.me, core.read_methods(self.state).get("users", {}))

    def test_set_and_remove_pin_for_the_bus_caller(self):
        old = core.POLICY_FILE
        core.POLICY_FILE = os.path.join(self.tmp.name, "none.conf")
        try:
            self.assertEqual(self.d("SetPin", [PIN]), {"ok": True})
        finally:
            core.POLICY_FILE = old
        self.assertTrue(core.read_methods(self.state)["users"][self.me]["pin"])
        self.assertNotIn(PIN, json.dumps(self.calls))
        self.assertEqual(self.d("RemovePin", []), {"ok": True})
        self.assertIsNone(core.read_pin(1000, self.state))

    def test_root_unknown_methods_and_bad_ids_are_refused(self):
        self.assertEqual(self.d("SetPin", [PIN], uid=0), {"ok": False, "error": "not_allowed"})
        self.assertEqual(self.d("Wipe", []), {"ok": False, "error": "bad_request"})
        self.assertEqual(self.d("RemoveKey", ["../x"]), {"ok": False, "error": "bad_request"})

    def test_interface_xml_lists_exactly_the_methods(self):
        xml = Path(__file__).resolve().parents[2].joinpath("dbus", "lk.worksuite.SignIn1.xml").read_text()
        import re
        self.assertEqual(sorted(re.findall(r'<method name="(\w+)"', xml)), sorted(bus.METHODS))

    def test_the_service_introspects_its_interface(self):
        # #56/#57 regression: the shell's dbus-next proxy needs lk.worksuite.SignIn1 in Introspect's reply.
        import re
        import xml.etree.ElementTree as ET
        node = ET.fromstring(bus.introspect(bus.PATH).split("\n", 2)[2])
        ifaces = {i.get("name"): sorted(m.get("name") for m in i.findall("method")) for i in node.findall("interface")}
        self.assertEqual(ifaces["lk.worksuite.SignIn1"], sorted(bus.METHODS))
        shipped = Path(__file__).resolve().parents[2].joinpath("dbus", "lk.worksuite.SignIn1.xml").read_text()
        squash = lambda x: re.sub(r"\s+", " ", re.search(r'<interface name="lk.worksuite.SignIn1">.*?</interface>', x, re.S).group(0))  # noqa: E731
        self.assertEqual(squash(bus.INTROSPECTION), squash(shipped))
        self.assertIn('<node name="lk"/>', bus.introspect("/"))
        self.assertIn('<node name="SignIn1"/>', bus.introspect("/lk/worksuite"))
        self.assertIsNone(bus.introspect("/other"))
