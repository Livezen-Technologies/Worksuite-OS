import unittest

from worksuite_osk.geometry import HEIGHT, docked, panel_height


class GeometryTest(unittest.TestCase):
    def test_docked_keyboard_sits_on_the_taskbar(self):
        margin, zone = docked("medium", 56)
        self.assertEqual(margin, 56)
        # the compositor reserves zone + margin, then the bridge's 56 px on top: apps end at the keyboard's top edge
        self.assertEqual(zone + margin + 56, HEIGHT["medium"] + 56)

    def test_kiosk_has_no_taskbar(self):
        self.assertEqual(panel_height(True, {"WORKSUITE_PANEL_HEIGHT": "56"}), 0)
        self.assertEqual(docked("large", 0), (0, HEIGHT["large"]))

    def test_panel_height_from_the_environment(self):
        self.assertEqual(panel_height(False, {}), 56)
        self.assertEqual(panel_height(False, {"WORKSUITE_PANEL_HEIGHT": "64"}), 64)
        self.assertEqual(panel_height(False, {"WORKSUITE_PANEL_HEIGHT": "x"}), 56)


if __name__ == "__main__":
    unittest.main()
