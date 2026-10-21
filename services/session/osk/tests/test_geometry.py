import unittest

from worksuite_osk.geometry import HEIGHT, docked, panel_height


class GeometryTest(unittest.TestCase):
    def test_docked_keyboard_sits_on_the_taskbar(self):
        margin, zone = docked("medium", 52)
        self.assertEqual(margin, 52)
        # the compositor reserves zone + margin, then the bridge's 52 px on top: apps end at the keyboard's top edge
        self.assertEqual(zone + margin + 52, HEIGHT["medium"] + 52)

    def test_kiosk_has_no_taskbar(self):
        self.assertEqual(panel_height(True, {"WORKSUITE_PANEL_HEIGHT": "56"}), 0)
        self.assertEqual(docked("large", 0), (0, HEIGHT["large"]))

    def test_panel_height_from_the_environment(self):
        self.assertEqual(panel_height(False, {}), 52)   # the taskbar's 52 px (#53), not 56
        self.assertEqual(panel_height(False, {"WORKSUITE_PANEL_HEIGHT": "64"}), 64)
        self.assertEqual(panel_height(False, {"WORKSUITE_PANEL_HEIGHT": "x"}), 52)

    def test_panel_height_from_the_shell_wins(self):
        # touch mode: the shell starts the keyboard with --panel 64 (shell/electron/touch.ts worksuiteOskArgs)
        self.assertEqual(panel_height(False, {"WORKSUITE_PANEL_HEIGHT": "52"}, panel=64), 64)
        self.assertEqual(panel_height(True, {}, panel=64), 0)


if __name__ == "__main__":
    unittest.main()
