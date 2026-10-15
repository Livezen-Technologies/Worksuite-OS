# Run: python3 -m unittest discover -s installer/modules/worksuitephase/tests
import os
import sys
import types
import unittest

gs = {}
lib = types.ModuleType("libcalamares")
lib.globalstorage = types.SimpleNamespace(value=lambda k: gs.get(k), insert=lambda k, v: gs.__setitem__(k, v))
lib.job = types.SimpleNamespace(configuration={})
sys.modules["libcalamares"] = lib
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import main  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "..")


class PhaseTests(unittest.TestCase):
    def setUp(self):
        gs.clear()

    def test_sets_phase(self):
        lib.job.configuration = {"phase": "boot"}
        self.assertIsNone(main.run())
        self.assertEqual(gs["worksuitePhase"], "boot")

    def test_rejects_unknown_phase(self):
        lib.job.configuration = {"phase": "nope"}
        self.assertIsNotNone(main.run())
        self.assertNotIn("worksuitePhase", gs)

    def test_every_phase_runs_in_order_before_its_jobs(self):
        import yaml
        settings = yaml.safe_load(open(os.path.join(ROOT, "settings.conf")))
        configs = {i["id"]: i["config"] for i in settings["instances"] if i["module"] == "worksuitephase"}
        execs = [j for s in settings["sequence"] for j in s.get("exec", [])]
        seen = []
        for job in execs:
            if job.startswith("worksuitephase@"):
                conf = yaml.safe_load(open(os.path.join(ROOT, "modules", configs[job.split("@")[1]])))
                seen.append(conf["phase"])
        self.assertEqual(tuple(seen), main.PHASES)
        self.assertEqual(execs[0], "worksuitephase@prepare")
        # "copy" only once the disk is partitioned and mounted: the slideshow must not say "Unpacking" before
        self.assertLess(execs.index("partition"), execs.index("worksuitephase@copy"))
        self.assertLess(execs.index("mount"), execs.index("worksuitephase@copy"))
        self.assertLess(execs.index("worksuitephase@copy"), execs.index("unpackfs"))
        self.assertLess(execs.index("worksuitephase@boot"), execs.index("bootloader"))
        self.assertLess(execs.index("worksuitephase@cleanup"), execs.index("umount"))


if __name__ == "__main__":
    unittest.main()
