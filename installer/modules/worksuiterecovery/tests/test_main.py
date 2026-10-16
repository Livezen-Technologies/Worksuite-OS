# Run: python3 -m unittest discover -s installer/modules/worksuiterecovery/tests
import os
import sys
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
            if argv[1] == "isLuks":
                return types.SimpleNamespace(returncode=0 if self.luks2 else 1, stderr="")
            i = argv.index("--key-file")
            files = argv[i + 1:]
            call = {"argv": argv, "cmd": argv[1], "device": files[1], "old": open(files[0]).read()}
            if len(files) > 2:
                call["new"] = open(files[2]).read()
                call["mode"] = oct(os.stat(files[2]).st_mode & 0o777)
            self.calls.append(call)
            return types.SimpleNamespace(returncode=self.code, stderr="No key available with this passphrase.")
        self.luks2 = True
        self.code = 0
        self.orig = main.add_key.__defaults__
        main.add_key.__defaults__ = (fake_run,)

    def tearDown(self):
        main.add_key.__defaults__ = self.orig

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
        adds = [c for c in self.calls if c["cmd"] == "luksAddKey"]
        self.assertEqual([c["device"] for c in adds], ["/dev/nvme0n1p2", "/dev/nvme0n1p3"])
        self.assertEqual({c["new"] for c in adds}, {gs[main.GS_KEY]}, "same key on every partition")
        self.assertTrue(all(c["old"] == "correct horse" for c in self.calls))
        self.assertTrue(all(c["mode"] == "0o600" for c in adds))
        self.assertTrue(all("correct horse" not in " ".join(c["argv"]) for c in self.calls), "no secret in argv")
        self.assertTrue(all(gs[main.GS_KEY] not in " ".join(c["argv"]) for c in self.calls), "no key in argv")

    def test_luks2_slots_use_pbkdf2_for_grub(self):
        gs["partitions"] = [{"device": "/dev/vda2", "luksPassphrase": "pw", "mountPoint": "/"}]
        self.assertIsNone(main.run())
        self.assertEqual([c["cmd"] for c in self.calls], ["luksConvertKey", "luksAddKey"])
        self.assertTrue(all(c["argv"][c["argv"].index("--pbkdf") + 1] == "pbkdf2" for c in self.calls))

    def test_luks1_only_adds_the_key(self):
        self.luks2 = False
        gs["partitions"] = [{"device": "/dev/vda2", "luksPassphrase": "pw", "mountPoint": "/"}]
        self.assertIsNone(main.run())
        self.assertEqual([c["cmd"] for c in self.calls], ["luksAddKey"])
        self.assertNotIn("--pbkdf", self.calls[0]["argv"])

    def test_failure_is_reported_and_no_key_is_shown(self):
        self.code = 2
        gs["partitions"] = [{"device": "/dev/sda2", "luksPassphrase": "x"}]
        title, detail = main.run()
        self.assertIn("recovery key", title)
        self.assertIn("/dev/sda2", detail)
        self.assertNotIn(main.GS_KEY, gs)


if __name__ == "__main__":
    unittest.main()
