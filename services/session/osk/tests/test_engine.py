"""On-screen keyboard logic (run: python3 -m unittest discover -s services/session/osk -t services/session/osk)."""
import os
import tempfile
import unittest

from worksuite_osk.__main__ import options
from worksuite_osk.control import parse, state_line
from worksuite_osk.engine import HINT_AUTOCAP, HINT_SENSITIVE, PURPOSE, Keyboard
from worksuite_osk.layouts import Key
from worksuite_osk.output import Output


def key(kb, label):
    for row in kb.rows():
        for k in row:
            if k.label == label:
                return k
    raise AssertionError(f"no key {label!r} in {[[k.label for k in r] for r in kb.rows()]}")


def typed(kb, *labels):
    out = []
    for lab in labels:
        out += kb.press(key(kb, lab))
    return "".join(a[1] for a in out if a[0] == "text")


class FieldTypes(unittest.TestCase):
    def test_layout_follows_content_purpose(self):
        kb = Keyboard()
        kb.set_field(PURPOSE["pin"])
        self.assertEqual([k.label for k in kb.rows()[0]], ["1", "2", "3"])
        kb.set_field(PURPOSE["number"])
        self.assertIn(".", [k.label for k in kb.rows()[3]])
        kb.set_field(PURPOSE["phone"])
        self.assertIn("+", [k.label for k in kb.rows()[3]])
        kb.set_field(PURPOSE["email"])
        bottom = [k.label for k in kb.rows()[-1]]
        self.assertIn("@", bottom)
        self.assertIn(".com", bottom)
        kb.set_field(PURPOSE["url"])
        bottom = [k.label for k in kb.rows()[-1]]
        self.assertIn("/", bottom)
        self.assertIn("Go", bottom)

    def test_email_and_url_stay_latin_even_in_sinhala(self):
        kb = Keyboard(lang="si")
        kb.set_field(PURPOSE["email"])
        self.assertEqual(kb.rows()[0][0].label, "q")
        kb.set_field(PURPOSE["normal"])
        self.assertEqual(kb.rows()[0][0].label, "ක")

    def test_autocap_once(self):
        kb = Keyboard()
        kb.set_field(PURPOSE["normal"], HINT_AUTOCAP)
        self.assertEqual(typed(kb, "H", "i"), "Hi")


class Scripts(unittest.TestCase):
    def test_sinhala_vowel_after_consonant_is_a_sign(self):
        kb = Keyboard(lang="si")
        kb.set_field()
        self.assertEqual(typed(kb, "ක", "ආ"), "කා")
        self.assertEqual(typed(kb, "අ"), "අ")          # a vowel on its own stays a vowel
        self.assertEqual(typed(kb, "ම", "ඉ", "ම"), "මිම")

    def test_tamil99_vowel_signs(self):
        kb = Keyboard(lang="ta")
        kb.set_field()
        self.assertEqual(typed(kb, "க", "ஆ"), "கா")
        self.assertEqual(typed(kb, "ம", "ஐ"), "மை")
        self.assertEqual(typed(kb, "ந", "்"), "ந்")

    def test_language_key_cycles(self):
        kb = Keyboard(langs=("en", "si", "ta"))
        kb.set_field()
        kb.press(key(kb, "EN"))
        self.assertEqual(kb.lang, "si")
        kb.press(key(kb, "සිං"))
        self.assertEqual(kb.lang, "ta")


class Suggestions(unittest.TestCase):
    def test_prefix_suggestions_and_pick(self):
        kb = Keyboard()
        kb.set_field()
        typed(kb, "t", "o", "m")
        self.assertEqual(kb.suggestions(), ["tomorrow"])
        acts = kb.pick("tomorrow")
        self.assertEqual(acts, [("key", "BackSpace")] * 3 + [("text", "tomorrow ")])

    def test_learning_is_private_and_skips_passwords(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "sub", "words.json")
            kb = Keyboard(learned_path=path)
            kb.set_field()
            typed(kb, "z", "e", "b", "r", "a")
            kb.press(Key("", "text: "))
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            kb2 = Keyboard(learned_path=path)
            kb2.set_field()
            typed(kb2, "z", "e")
            self.assertEqual(kb2.suggestions(), ["zebra"])
            kb2.set_field(PURPOSE["password"])
            typed(kb2, "s", "e", "c", "r", "e", "t")
            kb2.press(Key("", "text: "))
            self.assertEqual(kb2.suggestions(), [])
            kb2.set_field(PURPOSE["normal"], HINT_SENSITIVE)
            typed(kb2, "z", "e")
            self.assertEqual(kb2.suggestions(), [])
            self.assertNotIn("secret", open(path).read())

    def test_split_mode_cuts_rows(self):
        kb = Keyboard(mode="split")
        kb.set_field()
        left, right = kb.halves()
        self.assertEqual([k.label for k in left[0]], list("qwert"))
        self.assertEqual([k.label for k in right[0]], list("yuiop"))
        kb.set_field(PURPOSE["pin"])
        self.assertEqual(len(kb.halves()), 1)


class OutputAndControl(unittest.TestCase):
    def test_text_goes_on_stdin_never_argv(self):
        ran = []
        out = Output(run=lambda argv, stdin: ran.append((argv, stdin)) or 0, clipboard=lambda: "copied")
        out.apply([("text", "pass"), ("text", "word"), ("key", "BackSpace"), ("paste",), ("key", "rm -rf")])
        self.assertEqual(ran, [(["wtype", "-"], b"password"), (["wtype", "-k", "BackSpace"], None), (["wtype", "-"], b"copied")])

    def test_control_lines(self):
        self.assertEqual(parse("show 6 4"), ("show", 6, 4))
        self.assertEqual(parse("hide"), ("hide", 0, 0))
        self.assertEqual(parse("show 99 4"), ("show", 0, 4))
        self.assertIsNone(parse("show 6; reboot"))
        self.assertIsNone(parse("type secret"))

    def test_state_lines(self):
        self.assertEqual(state_line(True), "visible 1\n")
        self.assertEqual(state_line(False), "visible 0\n")

    def test_options(self):
        o = options(["--kiosk", "--mode", "split", "--langs", "si,xx,ta"])
        self.assertTrue(o.kiosk)
        self.assertEqual(o.langs, ("si", "ta"))


if __name__ == "__main__":
    unittest.main()
