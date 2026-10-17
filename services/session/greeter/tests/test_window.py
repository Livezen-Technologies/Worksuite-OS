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

    def test_input_purpose_goes_to_the_inner_text_of_a_password_entry(self):
        fn = next(n for n in self.tree.body if isinstance(n, ast.FunctionDef) and n.name == "set_input_purpose")
        ns = {}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(UI), "exec"), ns)

        class W:
            def __init__(self, has, child=None, sib=None):
                self.has, self.child, self.sib, self.props = has, child, sib, {}
            def find_property(self, name):
                return object() if self.has else None
            def set_property(self, name, value):
                if not self.has:
                    raise TypeError(name)
                self.props[name] = value
            def get_first_child(self):
                return self.child
            def get_next_sibling(self):
                return self.sib

        text = W(True)
        password = W(False, child=W(False, sib=text))
        ns["set_input_purpose"](password, "pin")
        self.assertEqual(text.props, {"input-purpose": "pin"})
        entry = W(True)
        ns["set_input_purpose"](entry, "digits")
        self.assertEqual(entry.props, {"input-purpose": "digits"})

    def test_startup_error_ends_the_greeter_so_the_wrapper_falls_back(self):
        fn = next(n for n in self.tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
        src = ast.unparse(fn)
        self.assertIn("except Exception", src)
        self.assertIn("a.quit()", src)
        self.assertIn("return 1 if failed else rc", src)
        self.assertNotIn('set_property("input-purpose"', UI.read_text().split("def set_input_purpose")[0])


if __name__ == "__main__":
    unittest.main()
