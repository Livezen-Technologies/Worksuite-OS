"""Catalog lint for the greeter (like the shell's catalog.lint.test.ts): every string the greeter shows has a Sinhala
and a Tamil translation with the same {placeholders}, nothing unknown is translated, no user-visible text skips _()."""
import ast
import re
import unittest
from pathlib import Path

from worksuite_greeter import i18n
from worksuite_greeter.i18n_si import SI, SI_PLURAL
from worksuite_greeter.i18n_ta import TA, TA_PLURAL

PKG = Path(__file__).resolve().parent.parent / "worksuite_greeter"
SOURCES = [PKG / "ui.py", PKG / "veil.py"]


def strings():
    single, plural = set(), set()
    for f in SOURCES:
        for n in ast.walk(ast.parse(f.read_text())):
            if not isinstance(n, ast.Call):
                continue
            name = n.func.id if isinstance(n.func, ast.Name) else getattr(n.func, "attr", None)
            args = [a.value for a in n.args if isinstance(a, ast.Constant) and isinstance(a.value, str)]
            if name in ("_", "gettext") and args:
                single.add(args[0])
            elif name == "ngettext" and len(args) >= 2:
                plural.add((args[0], args[1]))
    return single, plural


def holes(s):
    return sorted(re.findall(r"\{(\w+)\}", s))


class CatalogTest(unittest.TestCase):
    def test_every_string_is_translated(self):
        single, plural = strings()
        self.assertGreater(len(single), 50)
        for name, cat, pl in (("si", SI, SI_PLURAL), ("ta", TA, TA_PLURAL)):
            self.assertEqual(sorted(single - set(cat)), [], f"{name}: missing")
            self.assertEqual(sorted(set(cat) - single), [], f"{name}: unknown keys")
            self.assertEqual(sorted({one for one, _m in plural} - set(pl)), [], f"{name}: missing plurals")
            for k, v in cat.items():
                self.assertTrue(v.strip(), k)
                self.assertEqual(holes(k), holes(v), f"{name}: {k}")
            for (one, many) in plural:
                for form in pl[one]:
                    self.assertEqual(holes(one), holes(form), f"{name}: {one}")

    def test_no_literal_labels(self):
        """Gtk.Label/Button texts go through _() (brand names and key caps excepted)."""
        allowed = {"", "?", "!", "+", "WorkSuite"}
        for f in SOURCES:
            for n in ast.walk(ast.parse(f.read_text())):
                if isinstance(n, ast.Call):
                    for kw in n.keywords:
                        if kw.arg in ("label", "title", "tooltip_text", "placeholder_text") and isinstance(kw.value, ast.Constant):
                            self.assertIn(kw.value.value, allowed, f"{f.name}: {kw.arg}={kw.value.value!r}")

    def test_language_from_the_environment(self):
        self.assertEqual(i18n.language({"LANG": "si_LK.UTF-8"}), "si")
        self.assertEqual(i18n.language({"LANGUAGE": "ta:en", "LANG": "en_US.UTF-8"}), "ta")
        self.assertEqual(i18n.language({}), "en")
        self.assertEqual(i18n.translation("si").gettext("Sign in"), SI["Sign in"])
        self.assertEqual(i18n.translation("en").gettext("Sign in"), "Sign in")
        t = i18n.translation("ta")
        self.assertEqual(t.ngettext("Too many attempts. Try again in {n} minute.", "Too many attempts. Try again in {n} minutes.", 3),
                         TA_PLURAL["Too many attempts. Try again in {n} minute."][1])
        self.assertEqual(i18n.translation("en").ngettext("a {n}", "b {n}", 1), "a {n}")


if __name__ == "__main__":
    unittest.main()
