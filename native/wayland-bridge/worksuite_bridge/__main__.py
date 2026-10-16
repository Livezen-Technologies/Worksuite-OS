"""worksuite-wayland-bridge entry point (worksuite-wayland-bridge.service, Type=dbus)."""
from __future__ import annotations

import asyncio
import logging
import os
import signal

from dbus_next.aio import MessageBus

from .access import AccessPolicy
from .model import WindowRegistry
from .service import Bridge
from .workspace import LabwcKeys, WorkspaceTracker


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    from .wayland import WaylandBackend

    registry = WindowRegistry()
    bus = await MessageBus().connect()
    holder: dict[str, Bridge] = {}
    backend = WaylandBackend(registry, on_outputs_changed=lambda: holder["b"].outputs_changed() if "b" in holder else None,
                             panel_height=int(os.environ.get("WORKSUITE_PANEL_HEIGHT", "56")))  # DSK-005
    backend.connect()
    # Labwc desktops (rc.xml <desktops number="4"/>); WSOS-DSK-003.
    workspaces = WorkspaceTracker(registry, count=max(1, min(9, int(os.environ.get("WORKSUITE_WORKSPACES", "4")))))
    bridge = Bridge(bus, backend, registry, AccessPolicy(), workspaces=workspaces, keys=LabwcKeys())
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
