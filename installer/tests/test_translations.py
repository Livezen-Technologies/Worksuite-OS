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

    def test_unescape(self):
        self.assertEqual(extract.unescape('"a \\"b\\"" "c"'), 'a "b"c')


if __name__ == "__main__":
    unittest.main()
