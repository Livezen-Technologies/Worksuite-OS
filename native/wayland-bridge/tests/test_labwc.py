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


REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def _pixel(env, x, y):
    """The colour at (x, y) of the first output, from grim's binary PPM."""
    data = subprocess.run(["grim", "-t", "ppm", "-"], env=env, check=True, capture_output=True, timeout=10).stdout
    fields, pos = [], 0
    while len(fields) < 4:
        while data[pos:pos + 1].isspace():
            pos += 1
        if data[pos:pos + 1] == b"#":
            pos = data.index(b"\n", pos)
            continue
        end = pos
        while not data[end:end + 1].isspace():
            end += 1
        fields.append(data[pos:end])
        pos = end
    width = int(fields[1])
    off = pos + 1 + (y * width + x) * 3
    return tuple(data[off:off + 3])


@unittest.skipUnless(shutil.which("labwc") and shutil.which("foot") and shutil.which("grim") and shutil.which("wtype"),
                     "needs labwc, foot, grim and wtype")
class ShellStackingTest(unittest.TestCase):
    """WorkSuite's rc.xml in a headless Labwc: the full-screen shell (app_id worksuite-shell) stays below every app, after
    a click on it, on every desktop and after switching desktops; Task View's binding lifts it over the apps and back.
    (With the old omnipresent rule, a desktop switch put the shell over every app: app windows never showed.)"""
    BLUE, RED, GREEN = (0, 0, 255), (255, 0, 0), (0, 255, 0)

    def setUp(self):
        self.rt = tempfile.mkdtemp()
        os.chmod(self.rt, 0o700)
        cfg = os.path.join(self.rt, "labwc")
        os.makedirs(cfg)
        with open(os.path.join(REPO, "services/session/labwc/rc.xml")) as f:
            rc = f.read()
        from worksuite_bridge.workspace import rewrite_rc
        with open(os.path.join(cfg, "rc.xml"), "w") as f:
            f.write(rewrite_rc(rc, ["Desktop 1", "Desktop 2"], False))
        self.env = dict(os.environ, XDG_RUNTIME_DIR=self.rt, WLR_BACKENDS="headless", WLR_RENDERER="pixman", WLR_LIBINPUT_NO_DEVICES="1",
                        WLR_HEADLESS_OUTPUTS="1", WAYLAND_DISPLAY="", LANG="C.UTF-8")
        self.env.pop("DISPLAY", None)
        self.procs = [subprocess.Popen(["labwc", "-C", cfg], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
        for _ in range(100):
            socks = [f for f in os.listdir(self.rt) if f.startswith("wayland-") and not f.endswith(".lock")]
            if socks:
                self.env["WAYLAND_DISPLAY"] = socks[0]
                break
            time.sleep(0.05)
        else:
            self.fail("labwc did not start")

    def tearDown(self):
        for p in reversed(self.procs):
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        shutil.rmtree(self.rt, ignore_errors=True)

    def foot(self, app_id, colour, *extra):
        self.procs.insert(1, subprocess.Popen(["foot", "--app-id", app_id, "--title", app_id, "-o", f"colors.background={colour}", *extra,
                                               "sleep", "60"], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))

    def key(self, *argv):
        subprocess.run(["wtype", *argv], env=self.env, check=True, timeout=10)

    def bridge_key(self, k):
        self.key("-M", "ctrl", "-M", "alt", "-M", "logo", "-k", k, "-m", "logo", "-m", "alt", "-m", "ctrl")

    def wait_for(self, x, y, colour, timeout=10.0):
        end, got = time.time() + timeout, None
        while time.time() < end:
            got = _pixel(self.env, x, y)
            if got == colour:
                return
            time.sleep(0.1)
        self.fail(f"pixel ({x},{y}) is {got}, expected {colour}")

    def test_apps_stay_above_the_shell_on_every_desktop(self):
        self.foot("worksuite-shell", "0000ff", "--fullscreen")
        self.wait_for(10, 400, self.BLUE)
        self.foot("ws-app", "ff0000", "--window-size-chars=60x15")
        self.wait_for(640, 360, self.RED)                    # the app opens over the shell
        self.bridge_key("F2")                                # desktop 2: the shell is there too, no app
        self.wait_for(640, 360, self.BLUE)
        self.foot("ws-app2", "00ff00", "--window-size-chars=60x15")
        self.wait_for(640, 360, self.GREEN)
        self.bridge_key("F1")                                # back on 1: the app is still over the shell
        self.wait_for(640, 360, self.RED)
        self.wait_for(10, 400, self.BLUE)
        if shutil.which("wlrctl"):                           # a click on the taskbar focuses (and raises) the shell
            subprocess.run(["wlrctl", "toplevel", "focus", "app_id:worksuite-shell"], env=self.env, check=False, timeout=10)
            time.sleep(0.5)
            self.wait_for(640, 360, self.RED)
            subprocess.run(["wlrctl", "toplevel", "focus", "app_id:ws-app"], env=self.env, check=False, timeout=10)
            time.sleep(0.5)
        # The lift and the lowering act on the shell's windows whatever has the focus (here the app: the old toggle on
        # the focused window put the APP always on bottom), and both are idempotent.
        self.bridge_key("F23")                               # launcher / Task View: the shell over the apps …
        self.wait_for(640, 360, self.BLUE)
        self.bridge_key("F23")                               # … lifting again keeps it there
        self.wait_for(640, 360, self.BLUE)
        self.bridge_key("F2")                                # … on any desktop it switches to
        self.wait_for(640, 360, self.BLUE)
        self.bridge_key("F22")                               # closed: below the apps again
        self.wait_for(640, 360, self.GREEN)
        self.bridge_key("F22")                               # lowering twice changes nothing
        self.wait_for(640, 360, self.GREEN)
        self.bridge_key("F1")
        self.wait_for(640, 360, self.RED)
        self.wait_for(10, 400, self.BLUE)
