"""End-to-end against a headless Labwc: a real foot window appears, is minimized, activated and closed.
Skipped when labwc/foot or the generated protocol bindings are missing."""
import os
import shutil
import subprocess
import tempfile
import time
import unittest

from worksuite_bridge.model import ACTIVATED, MINIMIZED, WindowRegistry

try:
    from worksuite_bridge.wayland import WaylandBackend
    from worksuite_bridge.protocol import wlr_foreign_toplevel_management_unstable_v1  # noqa: F401
    HAVE_BINDINGS = True
except ImportError:
    HAVE_BINDINGS = False


@unittest.skipUnless(HAVE_BINDINGS and shutil.which("labwc") and shutil.which("foot"), "needs labwc, foot and generated bindings")
class LabwcTest(unittest.TestCase):
    def setUp(self):
        self.rt = tempfile.mkdtemp()
        os.chmod(self.rt, 0o700)
        env = dict(os.environ, XDG_RUNTIME_DIR=self.rt, WLR_BACKENDS="headless", WLR_RENDERER="pixman", WLR_LIBINPUT_NO_DEVICES="1", WAYLAND_DISPLAY="")
        env.pop("DISPLAY", None)
        cfg = os.path.join(self.rt, "labwc")
        os.makedirs(cfg)
        self.labwc = subprocess.Popen(["labwc", "-C", cfg], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.env = env
        for _ in range(100):
            socks = [f for f in os.listdir(self.rt) if f.startswith("wayland-") and not f.endswith(".lock")]
            if socks:
                self.display = os.path.join(self.rt, socks[0])
                break
            time.sleep(0.05)
        else:
            self.fail("labwc did not start")

    def tearDown(self):
        self.labwc.terminate()
        self.labwc.wait()
        shutil.rmtree(self.rt, ignore_errors=True)

    def pump(self, backend, cond, timeout=10.0):
        end = time.time() + timeout
        while time.time() < end:
            backend.display.roundtrip()
            if cond():
                return
            time.sleep(0.05)
        self.fail("timed out")

    def test_window_lifecycle(self):
        registry = WindowRegistry()
        backend = WaylandBackend(registry, display_name=self.display)
        backend.connect()
        self.assertEqual(backend.supported_operations(), ["activate", "close", "minimize"])
        foot = subprocess.Popen(["foot", "--app-id", "ws-test", "--title", "Bridge test", "--hold", "sleep", "30"],
                                env=dict(self.env, WAYLAND_DISPLAY=self.display), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.pump(backend, lambda: any(w.app_id == "ws-test" for w in registry.list()))
            w = next(w for w in registry.list() if w.app_id == "ws-test")
            self.assertEqual(w.title, "Bridge test")
            self.assertTrue(w.output)
            backend.set_minimized(w.native, True)
            self.pump(backend, lambda: w.flags & MINIMIZED)
            backend.activate(w.native, "")
            self.pump(backend, lambda: w.flags & ACTIVATED and not w.flags & MINIMIZED)
            backend.close(w.native)
            self.pump(backend, lambda: not registry.list())
            foot.wait(timeout=10)
        finally:
            backend.disconnect()
            if foot.poll() is None:
                foot.kill()
                foot.wait()


if __name__ == "__main__":
    unittest.main()
