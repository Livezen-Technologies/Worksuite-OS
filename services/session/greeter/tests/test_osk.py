"""Greeter on-screen keyboard: key handling without GTK."""
import unittest

from worksuite_greeter import osk


class OskTest(unittest.TestCase):
    def test_typing_and_backspace(self):
        self.assertEqual(osk.apply_key("ab", 1, "x"), ("axb", 2, None))
        self.assertEqual(osk.apply_key("ab", 2, "backspace"), ("a", 1, None))
        self.assertEqual(osk.apply_key("", 0, "backspace"), ("", 0, None))
        self.assertEqual(osk.apply_key("a", 1, "space"), ("a ", 2, None))
        self.assertEqual(osk.apply_key("a", 1, "at"), ("a@", 2, None))
        self.assertEqual(osk.apply_key("a", 1, "enter"), ("a", 1, "enter"))

    def test_layout_switching(self):
        self.assertEqual(osk.next_layout("lower", "shift"), "upper")
        self.assertEqual(osk.next_layout("upper", "shift"), "lower")
        self.assertEqual(osk.next_layout("lower", "symbols"), "symbols")
        self.assertEqual(osk.next_layout("symbols", "symbols"), "lower")

    def test_every_key_is_one_character(self):
        for rows in osk.ROWS.values():
            for row in rows:
                for ch in row:
                    self.assertEqual(osk.apply_key("", 0, ch)[0], ch)

    def test_toggle_icon_is_drawn_inside_its_box(self):
        rects = osk.icon_rects(18, 18)
        self.assertGreater(len(rects), 5)
        for x, y, w, h, _filled in rects:
            self.assertTrue(0 <= x and 0 <= y and x + w <= 18 and y + h <= 18)

    def test_toggle_uses_no_theme_icon(self):
        import pathlib
        src = (pathlib.Path(osk.__file__).parent / "ui.py").read_text()
        self.assertNotIn("input-keyboard-symbolic", src)


if __name__ == "__main__":
    unittest.main()
