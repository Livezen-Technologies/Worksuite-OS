"""Boot menu › Update WorkSuite OS: the window's reading of worksuite-offline-update (the tool itself is tested in
tests/boot/offline-update.test.sh)."""
import os
import stat
import tempfile
import unittest
from unittest import mock

from worksuite_greeter import updater


class ParseTest(unittest.TestCase):
    def test_scan(self):
        out = updater.parse_scan("system /dev/vda2 1.0.0~rc1\nlocked /dev/vda3\nbundle /run/live/medium/a.wsupdate\n"
                                 "bundle /run/worksuite-update/media/sdb1/b.wsupdate\nnoise\n")
        self.assertEqual(out, {"systems": [("/dev/vda2", "1.0.0~rc1")], "locked": ["/dev/vda3"],
                               "bundles": ["/run/live/medium/a.wsupdate", "/run/worksuite-update/media/sdb1/b.wsupdate"]})
        self.assertEqual(updater.parse_scan(""), {"systems": [], "locked": [], "bundles": []})

    def test_progress(self):
        self.assertEqual(updater.parse_progress("progress 42 installing\n"), ("progress", 42, "installing"))
        self.assertEqual(updater.parse_progress("progress 140 done"), ("progress", 100, "done"))
        self.assertEqual(updater.parse_progress("done"), ("done",))
        self.assertEqual(updater.parse_progress("error refused a downgrade"), ("error", "refused a downgrade"))
        self.assertIsNone(updater.parse_progress("Reading package lists..."))
        self.assertIsNone(updater.parse_progress("progress x y"))

    def test_json(self):
        self.assertEqual(updater.parse_json('{"version":"1.0.1","packages":3}\n'), {"version": "1.0.1", "packages": 3})
        self.assertEqual(updater.parse_json("error something\n"), {})
        self.assertEqual(updater.parse_json(""), {})


class BestBundleTest(unittest.TestCase):
    def test_newest_usable_in_debian_version_order(self):
        if not os.path.exists("/usr/bin/dpkg"):
            self.skipTest("needs dpkg --compare-versions")
        checked = [("a", {"version": "1.0.0~rc2"}), ("b", {"error": "bundle is not signed with the WorkSuite release key"}),
                   ("c", {"version": "1.0.0"}), ("d", {"version": "1.0.0~rc10"})]
        self.assertEqual(updater.best_bundle(checked)[0], "c")
        self.assertIsNone(updater.best_bundle([("b", {"error": "x"})]))
        self.assertIsNone(updater.best_bundle([]))


class ToolTest(unittest.TestCase):
    def test_runs_the_offline_update_tool_with_stdin(self):
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, "tool")
            with open(fake, "w") as f:
                f.write('#!/bin/sh\necho "$@"; cat\n')
            os.chmod(fake, stat.S_IRWXU)
            with mock.patch.object(updater, "TOOL", fake):
                code, out, _err = updater.tool("unlock", "/dev/vda3", stdin="secret\n")
            self.assertEqual(code, 0)
            self.assertEqual(out, "unlock /dev/vda3\nsecret\n")


if __name__ == "__main__":
    unittest.main()
