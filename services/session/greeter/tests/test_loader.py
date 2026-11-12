"""The greeter's loader plays exactly the boot splash's keyframes (worksuite.script), so splash → greeter has no jump."""
import pathlib
import re
import unittest

from worksuite_greeter import loader

ROOT = pathlib.Path(__file__).resolve().parents[4]


def script_frames(name, n):
    s = (ROOT / "branding/plymouth/worksuite.script").read_text()
    ts = [float(v) for v in re.findall(rf"{name}\.t\[\d\] = ([0-9.]+);", s)]
    vs = [float(v) for v in re.findall(rf"{name}\.v\[\d\] = ([0-9.]+);", s)]
    assert len(ts) == len(vs) == n, (name, ts, vs)
    return tuple(zip(ts, vs))


class LoaderTest(unittest.TestCase):
    def test_same_keyframes_as_the_boot_splash(self):
        self.assertEqual(loader.LEFT, script_frames("kl", 5))
        self.assertEqual(loader.BOTTOM, script_frames("kb", 6))
        self.assertEqual(loader.BLUE_SCALE, script_frames("kq", 7))
        self.assertEqual(loader.NAVY_SCALE, script_frames("kn", 6))
        self.assertIn("2.4 s at 50 Hz", (ROOT / "branding/plymouth/worksuite.script").read_text())

    def test_assembled_mark_mid_loop(self):
        c = loader.cells(1.2)                        # t = 0.5: all four in place, opaque
        self.assertEqual([(x, y, s) for x, y, s, _rgb, _a in c], [(16, 48, 32), (48, 80, 32), (48, 16, 64), (48, 48, 32)])
        self.assertTrue(all(a == 1 for *_r, a in c))

    def test_starts_empty_and_loops(self):
        self.assertEqual([round(a, 3) for *_r, a in loader.cells(0)], [0, 0])   # only the faded cyan cells exist
        for a, b in zip(loader.cells(0.7), loader.cells(0.7 + loader.PERIOD_S)):
            for x, y in zip(a, b):
                (self.assertAlmostEqual(x, y, places=9) if isinstance(x, float) else self.assertEqual(x, y))

    def test_reduced_motion_is_the_still_mark(self):
        self.assertEqual(loader.cells(0, reduced=True), loader.cells(1.2))


if __name__ == "__main__":
    unittest.main()
