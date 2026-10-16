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
