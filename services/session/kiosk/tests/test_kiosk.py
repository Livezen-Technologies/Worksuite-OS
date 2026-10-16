"""Kiosk exit PIN verification, throttling and the exit helper (run: python3 -m unittest discover -s services/session/kiosk)."""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import worksuite_kiosk as k  # noqa: E402

# Made by services/server/src/kiosk.ts pinVerifier('482915', 16 bytes of 7): the formats must agree.
SERVER_VERIFIER = "scrypt$32768$8$1$BwcHBwcHBwcHBwcHBwcHBw==$MJOrvaGrJH8k7BwuVk2dmBbw796dGajIP+xUwLrrDGc="


class VerifyPin(unittest.TestCase):
    def test_server_verifier(self):
        self.assertTrue(k.verify_pin("482915", SERVER_VERIFIER))
        self.assertFalse(k.verify_pin("482916", SERVER_VERIFIER))
        self.assertFalse(k.verify_pin("", SERVER_VERIFIER))
        self.assertFalse(k.verify_pin("48291a", SERVER_VERIFIER))

    def test_malformed_verifier_never_matches(self):
        for v in ("", "482915", "plain$482915", SERVER_VERIFIER.replace("32768", "2"), SERVER_VERIFIER.replace("$8$", "$1$"), None):
            self.assertFalse(k.verify_pin("482915", v), v)


class ThrottleTest(unittest.TestCase):
    def test_lockout_and_window(self):
        with tempfile.TemporaryDirectory() as d:
            now = [1000.0]
            t = k.Throttle(os.path.join(d, "sub", "f.json"), now=lambda: now[0])
            for _ in range(k.MAX_FAILURES - 1):
                t.fail()
            self.assertFalse(t.locked())
            t.fail()
            self.assertTrue(t.locked())
            self.assertEqual(os.stat(t.path).st_mode & 0o777, 0o600)
            now[0] += k.WINDOW_S + 1
            self.assertFalse(t.locked())
            t.fail(); t.clear()
            self.assertFalse(t.locked())


class ReadEnv(unittest.TestCase):
    def test_only_expected_shapes(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write("# x\nKIOSK_USER=kiosk\nKIOSK_EXIT_PIN=1\nKIOSK_IDLE_RESET_S=600; reboot\nKIOSK_USER2=$(id)\n")
        try:
            self.assertEqual(k.read_env(f.name), {"KIOSK_USER": "kiosk", "KIOSK_EXIT_PIN": "1"})
        finally:
            os.unlink(f.name)


class ExitHelper(unittest.TestCase):
    """The helper with stubbed loginctl/logger, as the current user playing the kiosk account."""

    def run_helper(self, mode, pin="", env_text=None, verifier=SERVER_VERIFIER):
        d = self.d
        user = __import__("pwd").getpwuid(os.getuid()).pw_name
        with open(os.path.join(d, "session.env"), "w") as f:
            f.write(env_text if env_text is not None else "KIOSK_USER=%s\nKIOSK_EXIT_PIN=1\n" % user)
        with open(os.path.join(d, "verifier"), "w") as f:
            f.write(verifier)
        env = {"PATH": d + "/stub:" + os.environ["PATH"], "PKEXEC_UID": str(os.getuid()), "WORKSUITE_KIOSK_ENV": d + "/session.env",
               "WORKSUITE_KIOSK_VERIFIER": d + "/verifier", "WORKSUITE_KIOSK_THROTTLE": d + "/throttle.json", "LOG": d + "/log"}
        # The installed helper imports from /usr/lib/worksuite/kiosk; point it at the source tree.
        src = open(os.path.join(os.path.dirname(HERE), "worksuite-kiosk-exit")).read().replace('"/usr/lib/worksuite/kiosk"', repr(os.path.dirname(HERE)))
        return subprocess.run([sys.executable, "-I", "-c", src, mode], input=pin + "\n", env=env, capture_output=True, text=True).returncode

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        os.makedirs(self.d + "/stub")
        for name in ("loginctl", "logger"):
            p = os.path.join(self.d, "stub", name)
            with open(p, "w") as f:
                f.write('#!/bin/sh\necho "%s $*" >> "$LOG"\n' % name)
            os.chmod(p, 0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def log(self):
        try:
            return open(self.d + "/log").read()
        except OSError:
            return ""

    def test_right_pin_ends_the_kiosk_session(self):
        self.assertEqual(self.run_helper("--pin", "482915"), 0)
        self.assertIn("loginctl terminate-user %d" % os.getuid(), self.log())

    def test_wrong_pin_refused_then_throttled(self):
        for _ in range(k.MAX_FAILURES):
            self.assertEqual(self.run_helper("--pin", "000001"), 3)
        self.assertEqual(self.run_helper("--pin", "482915"), 4, "locked out even with the right PIN")
        self.assertNotIn("terminate-user", self.log())

    def test_pin_off_by_policy(self):
        user = __import__("pwd").getpwuid(os.getuid()).pw_name
        self.assertEqual(self.run_helper("--pin", "482915", env_text="KIOSK_USER=%s\nKIOSK_EXIT_PIN=0\n" % user), 5)

    def test_only_the_kiosk_account(self):
        self.assertEqual(self.run_helper("--admin", env_text="KIOSK_USER=someoneelse\n"), 2)
        self.assertEqual(self.run_helper("--admin", env_text=""), 2)
        self.assertEqual(self.run_helper("--admin"), 0)
        self.assertEqual(self.run_helper("--bogus"), 2)


if __name__ == "__main__":
    unittest.main()


class ScreenOffTest(unittest.TestCase):
    def test_window_parsing_and_midnight(self):
        self.assertEqual(k.hhmm("2200"), 1320)
        self.assertEqual(k.hhmm("07:00"), 420)
        for bad in ("2400", "7:0", "", None, "22:60", "22:00;reboot"):
            self.assertIsNone(k.hhmm(bad), bad)
        start, end = 22 * 60, 7 * 60
        self.assertTrue(k.screen_off_now(23 * 60, start, end))
        self.assertTrue(k.screen_off_now(3 * 60, start, end))
        self.assertFalse(k.screen_off_now(7 * 60, start, end))
        self.assertFalse(k.screen_off_now(12 * 60, start, end))
        self.assertTrue(k.screen_off_now(13 * 60, 12 * 60, 14 * 60))
        self.assertFalse(k.screen_off_now(10, 5, 5))

    def test_seconds_to_change(self):
        import datetime
        start, end = 22 * 60, 7 * 60
        self.assertEqual(k.seconds_to_change(datetime.datetime(2026, 10, 16, 21, 59, 30), start, end), 30)
        self.assertEqual(k.seconds_to_change(datetime.datetime(2026, 10, 16, 23, 0, 0), start, end), 8 * 3600)
        self.assertEqual(k.seconds_to_change(datetime.datetime(2026, 10, 17, 7, 0, 0), start, end), 15 * 3600)

    def test_schedule_turns_outputs_off_and_on_once(self):
        ran, spawned = [], []

        class P:
            terminated = False

            def terminate(self):
                P.terminated = True

        s = k.ScreenSchedule(22 * 60, 7 * 60, lib="/lib/ws", run=ran.append, spawn=lambda a: spawned.append(a) or P())
        s.apply(12 * 60)
        self.assertEqual(ran, [["wlopm", "--on", "*"], ["/lib/ws/worksuite-kiosk-ctl", "screen-on"]])
        ran.clear()
        s.apply(22 * 60)
        s.apply(23 * 60)   # no change inside the window
        self.assertEqual(ran, [["/lib/ws/worksuite-kiosk-ctl", "screen-off", "07:00"], ["wlopm", "--off", "*"]])
        self.assertEqual(spawned[0][:4], ["swayidle", "-w", "timeout", "60"])
        self.assertIn("resume", spawned[0])
        ran.clear()
        s.apply(7 * 60)
        self.assertTrue(P.terminated)
        self.assertEqual(ran[-1], ["/lib/ws/worksuite-kiosk-ctl", "screen-on"])
