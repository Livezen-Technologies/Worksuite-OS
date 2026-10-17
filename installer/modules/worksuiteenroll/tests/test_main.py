# Run: python3 -m unittest discover -s installer/modules/worksuiteenroll/tests
import json
import os
import sys
import tempfile
import types
import unittest

gs = {}
logged = []
lib = types.ModuleType("libcalamares")
lib.globalstorage = types.SimpleNamespace(value=lambda k: gs.get(k), insert=lambda k, v: gs.__setitem__(k, v))
lib.utils = types.SimpleNamespace(debug=lambda *a: logged.append(" ".join(map(str, a))))
sys.modules["libcalamares"] = lib
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import main  # noqa: E402

TOKEN = "wse_secret-Token_1234"


class EnrollJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "target")
        os.mkdir(self.root)
        gs.clear()
        gs["rootMountPoint"] = self.root
        logged.clear()
        self.src = os.path.join(self.tmp.name, "enroll.json")

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, data, mode=0o600):
        fd = os.open(self.src, os.O_WRONLY | os.O_CREAT, mode)
        with os.fdopen(fd, "w") as f:
            f.write(data if isinstance(data, str) else json.dumps(data))
        os.chmod(self.src, mode)

    def dest(self):
        return os.path.join(self.root, main.TARGET_DIR, main.TARGET_NAME)

    def test_moves_into_target_privately_and_never_logs_the_token(self):
        self.put({"server": "https://ws.example.com/", "enrollment_token": TOKEN})
        self.assertIsNone(main.run(self.src))
        self.assertEqual(json.load(open(self.dest()))["enrollment_token"], TOKEN)
        self.assertEqual(os.stat(self.dest()).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(os.path.dirname(self.dest())).st_mode & 0o777, 0o700)
        self.assertFalse(os.path.exists(self.src), "live-session copy removed")
        self.assertNotIn(TOKEN, " ".join(logged))

    def test_nothing_to_do(self):
        self.assertIsNone(main.run(self.src))
        self.assertFalse(os.path.exists(self.dest()))

    def test_rejects_bad_content_or_wide_mode(self):
        for data, mode in (({"server": "http://x/", "enrollment_token": TOKEN}, 0o600),
                           ({"server": "https://ws.example.com/", "enrollment_token": "a b"}, 0o600),
                           ({"server": "https://ws.example.com/", "enrollment_token": TOKEN, "x": 1}, 0o600),
                           ("not json " + TOKEN, 0o600),
                           ({"server": "https://ws.example.com/", "enrollment_token": TOKEN}, 0o644)):
            self.put(data, mode)
            self.assertIsNone(main.run(self.src))
            self.assertFalse(os.path.exists(self.dest()), data)
            self.assertFalse(os.path.exists(self.src))
        self.assertNotIn(TOKEN, " ".join(logged))

    def test_symlink_source_is_ignored(self):
        other = os.path.join(self.tmp.name, "other")
        self.put({"server": "https://ws.example.com/", "enrollment_token": TOKEN})
        os.rename(self.src, other)
        os.symlink(other, self.src)
        self.assertIsNone(main.run(self.src))
        self.assertFalse(os.path.exists(self.dest()))


if __name__ == "__main__":
    unittest.main()
