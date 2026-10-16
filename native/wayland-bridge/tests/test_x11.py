"""X11 windows listed under their WM_CLASS class (worksuite_bridge/x11.py)."""
import os
import tempfile
import unittest

from worksuite_bridge.x11 import X11Classes, parse_tree, xwayland_running

TREE = '''
  Root window id: 0x3b (the root window) (has no name)
     0x400003 "Troubleshooting \\"x\\"": ("Navigator" "firefox-esr")  1280x638+0+26  +0+26
     0x60000a "xeyes": ("xeyes" "XEyes")  150x100+565+295  +565+295
     0x60000b (has no name): ()  1x1+0+0  +0+0
'''


class X11Test(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_tree(TREE), {"Navigator": "firefox-esr", "xeyes": "XEyes"})

    def test_resolve_only_asks_while_xwayland_runs(self):
        calls = []
        running = [False]
        x = X11Classes(tree=lambda: calls.append(1) or TREE, running=lambda: running[0])
        self.assertEqual(x.resolve("foot"), "foot")
        self.assertEqual(calls, [])                 # no Xwayland: never touches the X socket
        running[0] = True
        self.assertEqual(x.resolve("Navigator"), "firefox-esr")
        self.assertEqual(x.resolve("Navigator"), "firefox-esr")
        self.assertEqual(len(calls), 1)
        self.assertEqual(x.resolve("org.gnome.Nautilus"), "org.gnome.Nautilus")
        self.assertEqual(x.resolve(""), "")

    def test_xwayland_running(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(f"{d}/42")
            with open(f"{d}/42/comm", "w") as f:
                f.write("labwc\n")
            self.assertFalse(xwayland_running(d))
            os.makedirs(f"{d}/43")
            with open(f"{d}/43/comm", "w") as f:
                f.write("Xwayland\n")
            self.assertTrue(xwayland_running(d))
            self.assertFalse(xwayland_running(d, uid=os.getuid() + 1))


if __name__ == "__main__":
    unittest.main()
