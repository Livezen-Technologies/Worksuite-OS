"""worksuite-wayland-bridge entry point (worksuite-wayland-bridge.service, Type=dbus)."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import signal

from dbus_next.aio import MessageBus

from .access import AccessPolicy
from .model import WindowRegistry
from .service import Bridge
from .capture import OutputCapture
from .workspace import MAX_WORKSPACES, LabwcConfig, LabwcKeys, WorkspaceTracker


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    from .wayland import WaylandBackend

    registry = WindowRegistry()
    bus = await MessageBus().connect()
    holder: dict[str, Bridge] = {}
    backend = WaylandBackend(registry, on_outputs_changed=lambda: holder["b"].outputs_changed() if "b" in holder else None,
                             panel_height=int(os.environ.get("WORKSUITE_PANEL_HEIGHT", "56")))  # DSK-005
    backend.connect()
    # Labwc desktops (WSOS-DSK-003): count and names from the rc.xml Labwc runs with (the user's copy, else the system
    # one); WORKSUITE_WORKSPACES only when neither can be read.
    config = LabwcConfig()
    count, names = config.desktops() if config.read() else (max(1, min(MAX_WORKSPACES, int(os.environ.get("WORKSUITE_WORKSPACES", "4")))), [])
    # Names Labwc got as defaults ("Desktop 2") read back as "no name of its own"; the shell shows them translated.
    names = ["" if re.fullmatch(rf"(Desktop|Workspace) {i + 1}", x) else x for i, x in enumerate(names)]
    workspaces = WorkspaceTracker(registry, count=count, names=names)
    workspaces.switcher_all = 'allWorkspaces="yes"' in config.read()
    bridge = Bridge(bus, backend, registry, AccessPolicy(), workspaces=workspaces, keys=LabwcKeys(), config=config, capture=OutputCapture())
    holder["b"] = bridge
    loop = asyncio.get_running_loop()
    backend.attach(loop)
    await bridge.start()
    stop = asyncio.Event()
    for s in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(s, stop.set)
    await stop.wait()


if __name__ == "__main__":
    asyncio.run(main())
