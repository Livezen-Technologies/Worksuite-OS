# Run: python3 -m unittest discover -s installer/modules/worksuiteterms/tests
import os
import sys
import tempfile
import types
import unittest

gs = {}
lib = types.ModuleType("libcalamares")
lib.globalstorage = types.SimpleNamespace(value=lambda k: gs.get(k), insert=lambda k, v: gs.__setitem__(k, v))
lib.utils = types.SimpleNamespace(debug=lambda *a: None)
sys.modules["libcalamares"] = lib
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import main  # noqa: E402


class TermsJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        gs.clear()
        gs["rootMountPoint"] = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_records_version_and_time_world_readable(self):
        gs["worksuiteTerms"] = {"version": "0.1-draft", "acceptedAt": "2026-10-18T09:30:00Z"}
        self.assertIsNone(main.run())
        p = os.path.join(self.tmp.name, main.TARGET)
        with open(p) as f:
            self.assertEqual(f.read(), "version=0.1-draft\naccepted=2026-10-18T09:30:00Z\n")
        self.assertEqual(os.stat(p).st_mode & 0o777, 0o644)

    def test_no_acceptance_fails_the_install(self):
        self.assertIsNotNone(main.run())
        gs["worksuiteTerms"] = {"version": "x\nuser=alice", "acceptedAt": "2026-10-18T09:30:00Z"}
        self.assertIsNotNone(main.run())
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, main.TARGET)))

    def test_record_holds_no_other_fields(self):
        self.assertEqual(main.record({"version": "1", "acceptedAt": "2026-10-18T09:30:00Z", "user": "alice"}),
                         "version=1\naccepted=2026-10-18T09:30:00Z\n")


if __name__ == "__main__":
    unittest.main()
