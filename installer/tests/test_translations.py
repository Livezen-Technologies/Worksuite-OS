"""Installer localisation (SRS §11.5): every qsTr/tr string is in the Sinhala and Tamil .ts files, and the
.ts files keep placeholders intact in finished translations."""
import re
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

LANG = Path(__file__).resolve().parent.parent / "lang"
sys.path.insert(0, str(LANG))
import extract  # noqa: E402


class TranslationFilesTest(unittest.TestCase):
    def test_extractor_finds_qml_and_cpp_strings(self):
        src = extract.sources()
        self.assertIn("Quit installer", src["calamares-navigation"])
        self.assertIn("Type %1 to confirm that all data on it will be permanently deleted", src["WorksuiteConfirmViewStep"])
        # adjacent C++ literals are joined
        self.assertTrue(any(s.startswith("If you forget your disk passphrase, this key is the only way") and len(s) > 80 for s in src["WorksuiteConfirmViewStep"]))
        self.assertGreater(sum(map(len, src.values())), 80)

    def test_ts_files_cover_every_string(self):
        r = subprocess.run([sys.executable, str(LANG / "extract.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_finished_translations_keep_placeholders(self):
        for ts in LANG.glob("calamares-worksuite_*.ts"):
            for m in ET.parse(ts).getroot().iter("message"):
                t = m.find("translation")
                if t is None or t.get("type") == "unfinished":
                    continue
                self.assertEqual(sorted(re.findall(r"%\d", m.findtext("source", ""))), sorted(re.findall(r"%\d", t.text or "")), ts.name)

    def test_sinhala_and_tamil_are_complete(self):
        # SRS §11.5: Sinhala and Tamil in 1.0. Machine-drafted until reviewed (docs/i18n/README.md).
        for lang in extract.LANGS:
            root = ET.parse(LANG / f"calamares-worksuite_{lang}.ts").getroot()
            todo = [m.findtext("source") for m in root.iter("message") if m.find("translation").get("type") == "unfinished"]
            self.assertEqual(todo, [], lang)
            for m in root.iter("message"):
                t = m.find("translation")
                forms = [f.text for f in t.iter("numerusform")]
                if "%n" in m.findtext("source", ""):
                    self.assertEqual(m.get("numerus"), "yes")
                    self.assertTrue(forms and all(f and "%n" in f for f in forms), m.findtext("source"))
                else:
                    self.assertTrue((t.text or "").strip(), m.findtext("source"))

    def test_qm_files_are_named_for_the_branding(self):
        # Calamares looks for <branding>/lang/calamares-<componentName>_<lang>.qm.
        desc = (LANG.parent / "branding" / "worksuite" / "branding.desc").read_text(encoding="utf-8")
        component = re.search(r"^componentName:\s*(\S+)", desc, re.M).group(1)
        self.assertEqual(component, "worksuite")
        build = (LANG / "build.sh").read_text(encoding="utf-8")
        self.assertIn('out="$here/../branding/worksuite/lang"', build)
        self.assertIn("calamares-worksuite_*.ts", build)
        rules = (LANG.parent.parent / "packaging" / "debian" / "rules").read_text(encoding="utf-8")
        self.assertIn("installer/lang/build.sh", rules)
        self.assertIn("cp -a installer/branding/worksuite/.", rules)

    def test_unescape(self):
        self.assertEqual(extract.unescape('"a \\"b\\"" "c"'), 'a "b"c')


if __name__ == "__main__":
    unittest.main()
