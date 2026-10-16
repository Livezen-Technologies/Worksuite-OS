"""Certified hardware list and gates (WSOS-ARM-003): ARM uses the same gates as x86, nothing is listed as certified
without a pass for every gate and evidence, and the probe reports each gate."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = {"pass", "fail", "n/a", "pending"}
STATUSES = {"certified", "candidate", "ci-reference", "withdrawn"}


def rows(name):
    for line in (HERE / name).read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            yield line


def gates():
    out = {}
    for line in rows("gates.tsv"):
        gate, arches, _ = line.split(None, 2)
        out[gate] = set(arches.split(","))
    return out


def certified():
    cols = ["arch", "vendor", "model", "firmware", "status", *gates(), "evidence"]
    out = []
    for line in rows("certified.tsv"):
        cells = line.split("\t")
        if len(cells) != len(cols):
            raise AssertionError(f"wrong column count: {line!r}")
        out.append(dict(zip(cols, cells)))
    return out


class GatesTest(unittest.TestCase):
    def test_arm_and_x86_share_every_gate(self):
        g = gates()
        for gate in ("uefi", "gpu", "wifi", "suspend"):
            self.assertIn(gate, g)
        for gate, arches in g.items():
            self.assertEqual(arches, {"amd64", "arm64"}, gate)

    def test_certified_rows_are_complete(self):
        for r in certified():
            self.assertIn(r["arch"], {"amd64", "arm64"})
            self.assertIn(r["status"], STATUSES)
            for gate in gates():
                self.assertIn(r[gate], RESULTS, (r["model"], gate))
            if r["status"] == "certified":
                self.assertEqual(r["firmware"], "UEFI")
                for gate in gates():
                    self.assertEqual(r[gate], "pass", f"{r['model']}: {gate} must pass to be certified")
                self.assertTrue(r["evidence"].strip())

    def test_virtual_machines_are_never_certified(self):
        for r in certified():
            if r["vendor"] == "QEMU":
                self.assertNotEqual(r["status"], "certified")

    def test_arm_rows_boot_uefi(self):
        for r in certified():
            if r["arch"] == "arm64":
                self.assertEqual(r["firmware"], "UEFI", "WSOS-ARM-002: no vendor device-tree boot")


class ProbeTest(unittest.TestCase):
    def run_probe(self, files, links=()):
        with tempfile.TemporaryDirectory() as d:
            for p, v in files.items():
                os.makedirs(os.path.dirname(os.path.join(d, p)), exist_ok=True)
                Path(d, p).write_text(v)
            for p, target in links:
                os.makedirs(os.path.dirname(os.path.join(d, p)), exist_ok=True)
                os.symlink(target, os.path.join(d, p))
            r = subprocess.run(["sh", str(HERE / "probe.sh")], env={**os.environ, "SYSFS": d, "SKIP_SUSPEND": "1"}, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            return {line.split("\t")[0]: line.split("\t")[1] for line in r.stdout.splitlines()}

    def test_probe_reports_every_gate(self):
        out = self.run_probe({
            "firmware/efi/x": "", "class/net/wlan0/wireless/x": "", "block/nvme0n1/removable": "0", "block/nvme0n1/size": "100",
            "class/drm/card0/device/vendor": "0x1002",
        }, [("class/drm/card0/device/driver", "../../bus/pci/drivers/amdgpu")])
        self.assertEqual(set(out), set(gates()))
        self.assertEqual(out["uefi"], "pass")
        self.assertEqual(out["gpu"], "pass")
        self.assertEqual(out["wifi"], "pass")
        self.assertEqual(out["storage"], "pass")
        self.assertEqual(out["suspend"], "skip")

    def test_firmware_framebuffer_alone_fails_the_gpu_gate(self):
        out = self.run_probe({"class/drm/card0/device/x": ""}, [("class/drm/card0/device/driver", "../../bus/platform/drivers/simpledrm")])
        self.assertEqual(out["gpu"], "fail")
        self.assertEqual(out["uefi"], "fail")
        self.assertEqual(out["wifi"], "fail")
        self.assertEqual(out["storage"], "fail")


if __name__ == "__main__":
    unittest.main()
