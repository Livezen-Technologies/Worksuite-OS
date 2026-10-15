# Run: python3 -m unittest discover -s installer/modules/worksuiterecovery/tests
import os
import sys
import tempfile
import types
import unittest

# Minimal stand-in for Calamares' libcalamares module.
gs = {}
lib = types.ModuleType("libcalamares")
lib.globalstorage = types.SimpleNamespace(value=lambda k: gs.get(k), insert=lambda k, v: gs.__setitem__(k, v))
lib.utils = types.SimpleNamespace(debug=lambda *_: None)
sys.modules["libcalamares"] = lib
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import main  # noqa: E402


class RecoveryKeyTests(unittest.TestCase):
    def setUp(self):
        gs.clear()
        self.calls = []

        def fake_run(argv, **_):
            old, new = argv[4], argv[6]
            self.calls.append({"argv": argv, "old": open(old).read(), "new": open(new).read(),
                               "mode": oct(os.stat(new).st_mode & 0o777)})
            return types.SimpleNamespace(returncode=self.code, stderr="No key available with this passphrase.")
        self.code = 0
        self.orig = main.add_key.__defaults__
        main.add_key.__defaults__ = (fake_run,)
        # /run is root-only outside the installer (package builds run as a normal user).
        self.orig_dir = main.SECRET_DIR
        if not os.access(main.SECRET_DIR, os.W_OK):
            main.SECRET_DIR = tempfile.gettempdir()

    def tearDown(self):
        main.add_key.__defaults__ = self.orig
        main.SECRET_DIR = self.orig_dir

    def test_key_format(self):
        k = main.make_key()
        self.assertRegex(k, r"^([0-9A-HJKMNP-TV-Z]{5}-){7}[0-9A-HJKMNP-TV-Z]{5}$")
        self.assertNotEqual(k, main.make_key())

    def test_unencrypted_install_does_nothing(self):
        gs["partitions"] = [{"device": "/dev/sda2", "mountPoint": "/"}]
        self.assertIsNone(main.run())
        self.assertEqual(self.calls, [])
        self.assertNotIn(main.GS_KEY, gs)

    def test_adds_one_key_to_each_encrypted_partition(self):
        gs["partitions"] = [
            {"device": "/dev/nvme0n1p2", "luksPassphrase": "correct horse", "mountPoint": "/"},
            {"device": "/dev/nvme0n1p3", "luksPassphrase": "correct horse", "mountPoint": "swap"},
            {"device": "/dev/nvme0n1p1", "mountPoint": "/boot/efi"},
        ]
        self.assertIsNone(main.run())
        self.assertEqual([c["argv"][5] for c in self.calls], ["/dev/nvme0n1p2", "/dev/nvme0n1p3"])
        self.assertTrue(all(c["argv"][:4] == ["cryptsetup", "luksAddKey", "--batch-mode", "--key-file"] for c in self.calls))
        self.assertEqual({c["new"] for c in self.calls}, {gs[main.GS_KEY]}, "same key on every partition")
        self.assertTrue(all(c["old"] == "correct horse" for c in self.calls))
        self.assertTrue(all(c["mode"] == "0o600" for c in self.calls))
        self.assertTrue(all("correct horse" not in " ".join(c["argv"]) for c in self.calls), "no secret in argv")

    def test_failure_is_reported_and_no_key_is_shown(self):
        self.code = 2
        gs["partitions"] = [{"device": "/dev/sda2", "luksPassphrase": "x"}]
        title, detail = main.run()
        self.assertIn("recovery key", title)
        self.assertIn("/dev/sda2", detail)
        self.assertNotIn(main.GS_KEY, gs)


if __name__ == "__main__":
    unittest.main()
