"""Cross-component test: the shell's panel client (TypeScript, dbus-next for Node) against this bridge.
Covers window list + signals, activation, NotFound mapping and the lk.worksuite.Shell1 Super-key call.
Skipped when Node ≥ 22.6 or the shell's node_modules are not available (e.g. in the Debian build)."""
import asyncio
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from dbus_next.aio import MessageBus

from worksuite_bridge.access import AccessPolicy
from worksuite_bridge.model import ACTIVATED, WindowRegistry
from worksuite_bridge.service import Bridge

from .busutil import PrivateBus
from .test_dbus import FakeBackend

HERE = Path(__file__).resolve().parent
SHELL = HERE.parent.parent.parent / "shell"
NODE = shutil.which("node")


def node_ok() -> bool:
    if not NODE or not (SHELL / "node_modules" / "dbus-next").is_dir() or not shutil.which("busctl"):
        return False
    out = subprocess.run([NODE, "-p", "process.versions.node"], capture_output=True, text=True).stdout.strip().split(".")
    return len(out) >= 2 and (int(out[0]), int(out[1])) >= (22, 6)


@unittest.skipUnless(node_ok(), "needs node >= 22.6, busctl and shell/node_modules")
class ShellClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_panel_client_against_bridge(self):
        with PrivateBus() as pb:
            registry, backend = WindowRegistry(), FakeBackend()
            bus = await MessageBus(bus_address=pb.address).connect()
            # The node binary stands in for the installed Electron binary in the caller check.
            await Bridge(bus, backend, registry, AccessPolicy(allowed=(os.path.realpath(NODE),))).start()
            registry.add("n1", "foot", "Terminal", "HDMI-A-1", ACTIVATED)
            p = await asyncio.create_subprocess_exec(NODE, "--experimental-strip-types", "--no-warnings", str(HERE / "shell_client.mts"),
                                                     env=dict(os.environ, DBUS_SESSION_BUS_ADDRESS=pb.address),
                                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            self.assertEqual((await asyncio.wait_for(p.stdout.readline(), 20)).strip(), b"ready")
            registry.add("n2", "firefox-esr", "Web")
            await asyncio.sleep(0.3)
            r = await asyncio.to_thread(subprocess.run, ["busctl", f"--address={pb.address}", "call", "lk.worksuite.Shell1", "/lk/worksuite/Shell1",
                                                         "lk.worksuite.Shell1", "ToggleLauncher"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            p.stdin.write(b"go\n")
            await p.stdin.drain()
            out = (await asyncio.wait_for(p.communicate(), 20))[0].decode().splitlines()
            self.assertIn("windows foot", out)
            self.assertIn("windows foot,firefox-esr", out)   # WindowAdded signal → refresh
            self.assertIn("launcher toggle", out)
            self.assertIn('activate {"ok":true,"value":true}', out)
            self.assertIn('stale {"ok":false,"error":"not_found"}', out)
            self.assertEqual(backend.calls, [("activate", "n1", "")])
            bus.disconnect()


if __name__ == "__main__":
    unittest.main()
