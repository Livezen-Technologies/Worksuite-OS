#!/usr/bin/env python3
"""Stand-in for the shell's notification server in the portal test: owns org.freedesktop.Notifications on the session
bus and appends each Notify summary to the file given as argv[1]."""
import asyncio
import sys

from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, method

LOG = sys.argv[1]


class Notifications(ServiceInterface):
    def __init__(self):
        super().__init__('org.freedesktop.Notifications')
        self.n = 0

    @method()
    def Notify(self, app: 's', replaces: 'u', icon: 's', summary: 's', body: 's', actions: 'as', hints: 'a{sv}', timeout: 'i') -> 'u':  # noqa: F821,E501
        self.n += 1
        with open(LOG, 'a') as f:
            f.write(f'{app}\t{summary}\t{body}\n')
        return self.n

    @method()
    def CloseNotification(self, nid: 'u'):  # noqa: F821
        pass

    @method()
    def GetCapabilities(self) -> 'as':  # noqa: F821
        return ['body', 'actions']

    @method()
    def GetServerInformation(self) -> 'ssss':  # noqa: F821
        return ['worksuite-test', 'WorkSuite', '1', '1.2']


async def main():
    bus = await MessageBus().connect()
    bus.export('/org/freedesktop/Notifications', Notifications())
    await bus.request_name('org.freedesktop.Notifications')
    await asyncio.Future()

asyncio.run(main())
