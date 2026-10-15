"""worksuite-wayland-bridge entry point (worksuite-wayland-bridge.service, Type=dbus)."""
from __future__ import annotations

import asyncio
import logging
import signal

from dbus_next.aio import MessageBus

from .access import AccessPolicy
from .model import WindowRegistry
from .service import Bridge


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    from .wayland import WaylandBackend

    registry = WindowRegistry()
    bus = await MessageBus().connect()
    holder: dict[str, Bridge] = {}
    backend = WaylandBackend(registry, on_outputs_changed=lambda: holder["b"].outputs_changed() if "b" in holder else None)
    backend.connect()
    bridge = Bridge(bus, backend, registry, AccessPolicy())
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
