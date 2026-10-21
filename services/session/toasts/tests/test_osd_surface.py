"""#62: the level indicator is a layer-shell overlay surface mapped once and kept (checked in the source: the GTK and
gtk4-layer-shell bindings are not needed to run the unit tests)."""
import ast
import unittest
from pathlib import Path

UI = Path(__file__).resolve().parents[1] / "worksuite_toasts" / "ui.py"


def _class(tree: ast.Module, name: str) -> ast.ClassDef:
    return next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == name)


def _method(cls: ast.ClassDef, name: str) -> str:
    return ast.unparse(next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == name))


class OsdSurfaceTest(unittest.TestCase):
    def setUp(self):
        self.src = UI.read_text()
        self.tree = ast.parse(self.src)
        self.osd = _class(self.tree, "OsdWindow")

    def test_on_the_overlay_layer_without_focus_or_input(self):
        init = _method(self.osd, "__init__")
        self.assertIn("LS.set_layer(self, LS.Layer.OVERLAY)", init)
        self.assertIn("LS.set_keyboard_mode(self, LS.KeyboardMode.NONE)", init)
        self.assertIn("set_input_region(cairo.Region())", _method(self.osd, "_no_input"))

    def test_mapped_at_start_and_never_unmapped(self):
        run = next(n for n in self.tree.body if isinstance(n, ast.FunctionDef) and n.name == "run")
        body = ast.unparse(run)
        # created with the toast window, before any line is read: not lazily on the first key press
        self.assertLess(body.index("OsdWindow(a)"), body.index("io_add_watch"))
        self.assertIn("state['osd'].present()", body)
        self.assertNotIn("set_visible(False)", ast.unparse(self.osd))
        self.assertIn("set_opacity(0)", _method(self.osd, "_hide"))
        self.assertIn("set_opacity(1)", _method(self.osd, "show_level"))


if __name__ == "__main__":
    unittest.main()
