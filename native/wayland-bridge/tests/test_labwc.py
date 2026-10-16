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
    OUTPUTS = "1"

    def setUp(self):
        self.rt = tempfile.mkdtemp()
        os.chmod(self.rt, 0o700)
        env = dict(os.environ, XDG_RUNTIME_DIR=self.rt, WLR_BACKENDS="headless", WLR_RENDERER="pixman", WLR_LIBINPUT_NO_DEVICES="1", WLR_HEADLESS_OUTPUTS=self.OUTPUTS, WAYLAND_DISPLAY="")
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


def _probe_usable(display):
    """A second client maps a layer surface with exclusive_zone 0 anchored to all edges on each output; Labwc
    configures it to the output's usable area, i.e. what is left after other clients' exclusive zones."""
    from pywayland.client import Display
    from worksuite_bridge.protocol import wayland as wl
    from worksuite_bridge.protocol import wlr_layer_shell_unstable_v1 as ls
    d = Display(display)
    d.connect()
    g = {"out": []}

    def glob(reg, name, iface, ver):
        if iface == "wl_compositor":
            g["comp"] = reg.bind(name, wl.WlCompositor, 4)
        elif iface == "zwlr_layer_shell_v1":
            g["ls"] = reg.bind(name, ls.ZwlrLayerShellV1, 3)
        elif iface == "wl_output":
            g["out"].append(reg.bind(name, wl.WlOutput, 1))
    reg = d.get_registry()
    reg.dispatcher["global"] = glob
    d.roundtrip()
    sizes, keep = {}, []
    for i, o in enumerate(g["out"]):
        surf = g["comp"].create_surface()
        lay = g["ls"].get_layer_surface(surf, o, 1, "probe")
        lay.set_anchor(15)
        lay.set_exclusive_zone(0)
        lay.dispatcher["configure"] = lambda _l, _s, w, h, i=i: sizes.__setitem__(i, (w, h))
        surf.commit()
        keep.append((surf, lay))
    d.roundtrip()
    d.roundtrip()
    del keep, g, reg
    import gc
    gc.collect()
    d.disconnect()
    return sorted(sizes.values())


@unittest.skipUnless(HAVE_BINDINGS and shutil.which("labwc"), "needs labwc and generated bindings")
class TwoOutputLabwcTest(LabwcTest):
    """WSOS-DSK-005/007: two virtual monitors; the bridge reserves the panel edge on each and follows hotplug."""
    OUTPUTS = "2"

    def test_window_lifecycle(self):
        self.skipTest("covered by LabwcTest")

    def test_panel_reserved_per_output_and_hotplug(self):
        registry = WindowRegistry()
        changes = []
        backend = WaylandBackend(registry, on_outputs_changed=lambda: changes.append(1), display_name=self.display, panel_height=48)
        backend.connect()
        try:
            self.pump(backend, lambda: len(backend.outputs()) == 2 and len(backend.reserver.reserved()) == 2)
            names = sorted(o.name for o in backend.outputs())
            self.assertEqual(names, ["HEADLESS-1", "HEADLESS-2"])
            outs = {o.name: o for o in backend.outputs()}
            # Each output's usable area loses exactly the panel height (maximised windows stop above the panel).
            usable = _probe_usable(self.display)
            self.assertEqual(usable, sorted((o.width, o.height - 48) for o in outs.values()))
            for w, h in backend.reserver.reserved().values():
                self.assertEqual(h, 48)
                self.assertGreater(w, 0)
            if not shutil.which("wlr-randr"):
                return
            env = dict(self.env, WAYLAND_DISPLAY=self.display)
            # Per-output scale (DSK-005 100-200 %): the reservation stays the panel height in logical pixels.
            w2, h2 = outs["HEADLESS-2"].width, outs["HEADLESS-2"].height
            subprocess.run(["wlr-randr", "--output", "HEADLESS-2", "--scale", "2"], env=env, check=True)
            self.pump(backend, lambda: outs["HEADLESS-2"].scale == 2.0)
            self.assertIn((w2 // 2, h2 // 2 - 48), _probe_usable(self.display))
            # One shell window per monitor, each listed on its own output.
            from .wlclient import FullscreenClient
            client = FullscreenClient(self.display)
            try:
                client.fullscreen_on("HEADLESS-1", "WorkSuite desktop HEADLESS-1")
                client.fullscreen_on("HEADLESS-2", "WorkSuite desktop HEADLESS-2")

                def placed():
                    client.pump()
                    return sorted((w.title[-10:], w.output) for w in registry.list()) == [("HEADLESS-1", "HEADLESS-1"), ("HEADLESS-2", "HEADLESS-2")]
                self.pump(backend, placed)
                # Unplug: the output and its reservation disappear, the shell is told and Labwc moves the window (DSK-007).
                changes.clear()
                subprocess.run(["wlr-randr", "--output", "HEADLESS-2", "--off"], env=env, check=True)

                def unplugged():
                    client.pump()
                    return ([o.name for o in backend.outputs()] == ["HEADLESS-1"] and len(backend.reserver.reserved()) == 1
                            and all(w.output == "HEADLESS-1" for w in registry.list()))
                self.pump(backend, unplugged)
                self.assertTrue(changes)
            finally:
                client.close()
            # Re-plug: a new reservation is made.
            subprocess.run(["wlr-randr", "--output", "HEADLESS-2", "--on"], env=env, check=True)
            self.pump(backend, lambda: len(backend.outputs()) == 2 and len(backend.reserver.reserved()) == 2)
        finally:
            backend.disconnect()


if __name__ == "__main__":
    unittest.main()
