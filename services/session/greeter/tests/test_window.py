"""The greeter window is fullscreen with no title bar or close button (checked without GTK: the helper is run on a
stand-in window, and the window class is checked to call it)."""
import ast
import unittest
from pathlib import Path

UI = Path(__file__).resolve().parent.parent / "worksuite_greeter" / "ui.py"


class FakeWindow:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        return lambda *a: self.calls.append((name, a))


class WindowTest(unittest.TestCase):
    def setUp(self):
        self.tree = ast.parse(UI.read_text())

    def test_undecorate_makes_it_fullscreen_without_chrome(self):
        fn = next(n for n in self.tree.body if isinstance(n, ast.FunctionDef) and n.name == "undecorate")
        ns = {}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(UI), "exec"), ns)
        win = FakeWindow()
        ns["undecorate"](win)
        self.assertIn(("set_decorated", (False,)), win.calls)
        self.assertIn(("set_deletable", (False,)), win.calls)
        self.assertIn(("fullscreen", ()), win.calls)

    def test_greeter_window_calls_it(self):
        cls = next(n for n in self.tree.body if isinstance(n, ast.ClassDef) and n.name == "Greeter")
        init = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "__init__")
        calls = [n.func.id for n in ast.walk(init) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)]
        self.assertIn("undecorate", calls)


if __name__ == "__main__":
    unittest.main()
