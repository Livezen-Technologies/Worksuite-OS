"""The veil's boot text belongs to the first greeter after boot only (E2E: "Booting…" after sign-out)."""
import os
import tempfile
import unittest

from worksuite_greeter import veil


class BootHandoffTest(unittest.TestCase):
    def test_first_greeter_then_after_sign_out(self):
        with tempfile.TemporaryDirectory() as d:
            ready = os.path.join(d, "greeter", "ready")
            self.assertTrue(veil.boot_handoff(ready))     # greetd just cleared it: the boot splash hands over
            veil.mark_ready(ready)
            self.assertFalse(veil.boot_handoff(ready))    # the next greeter (after sign-out): no "Booting…"

    def test_greetd_clears_the_mark_once_per_start(self):
        unit = open(os.path.join(os.path.dirname(__file__), "../../systemd/greetd/greetd.service"), encoding="utf-8").read()
        self.assertIn("ExecStartPre=-/bin/rm -f /run/worksuite/greeter/ready", unit)


if __name__ == "__main__":
    unittest.main()


class SessionVeilTest(unittest.TestCase):
    def test_leaves_on_the_shells_first_frame_or_its_failure_never_on_a_timer(self):
        import time
        with tempfile.TemporaryDirectory() as d:
            ready = os.path.join(d, "shell-ready")
            started = time.time()
            self.assertFalse(veil.session_done(ready, started, lambda: False))
            with open(ready, "w") as f:
                f.write("1")
            os.utime(ready, (started - 100, started - 100))          # from an earlier session
            self.assertFalse(veil.session_done(ready, started, lambda: False))
            os.utime(ready, None)
            self.assertTrue(veil.session_done(ready, started, lambda: False))
            os.remove(ready)
            self.assertTrue(veil.session_done(ready, started, lambda: True))   # the shell's unit failed


class InstallerLoadingTest(unittest.TestCase):
    """The installer's loading screen: animated from the splash's still frame; Calamares continues it (WsIntro.cpp)."""

    def test_motion_starts_from_the_splash_frame(self):
        self.assertEqual(veil.breath(0), (1.0, 1.0))                  # the mark as the splash left it
        a, s = veil.breath(veil.BREATH_S / 2)
        self.assertAlmostEqual(a, 0.78)
        self.assertAlmostEqual(s, 1.04)
        self.assertEqual(veil.shimmer(0), -veil.SHIMMER_W)           # enters from the bar's left end
        self.assertAlmostEqual(veil.shimmer(veil.SHIMMER_S * 0.999), 420, delta=1)

    def test_reduced_motion(self):
        self.assertTrue(veil.reduced_motion({"WORKSUITE_REDUCED_MOTION": "1"}))
        self.assertFalse(veil.reduced_motion({}))

        class Off:
            def get_property(self, name):
                return name != "gtk-enable-animations"
        self.assertTrue(veil.reduced_motion({}, Off()))

    def test_calamares_gets_the_clock_and_texts(self):
        env = veil.intro_env("Starting the installer…", "WorkSuite OS 1.1", 12345, False, {"PATH": "/bin"})
        self.assertEqual(env["WORKSUITE_INTRO_T0"], "12345")
        self.assertEqual(env["WORKSUITE_INTRO_TITLE"], "Starting the installer…")
        self.assertEqual(env["PATH"], "/bin")
        self.assertNotIn("WORKSUITE_REDUCED_MOTION", env)
        self.assertEqual(veil.intro_env("", "", 0, True, {})["WORKSUITE_REDUCED_MOTION"], "1")

    def test_same_motion_constants_in_calamares(self):
        cpp = open(os.path.join(os.path.dirname(__file__), "../../../../installer/modules/worksuiteconfirm/WsIntro.cpp"), encoding="utf-8").read()
        for name, value in (("BREATH_S", veil.BREATH_S), ("SHIMMER_S", veil.SHIMMER_S), ("SHIMMER_W", veil.SHIMMER_W)):
            self.assertRegex(cpp, r"%s = %s\b" % (name, value))
