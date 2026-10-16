#!/usr/bin/env python3
"""Portal acceptance (SRS §7.1, WSOS-INT-012/013): each xdg-desktop-portal interface WorkSuite uses, called over D-Bus
against the real xdg-desktop-portal with the -wlr and -gtk backends, in a headless Labwc session. "Portal installed"
is not a pass: every test makes the request an app makes and checks the result.

Run through tests/portals/run.sh, which starts the private session bus, PipeWire, Labwc and the WorkSuite portal
configuration. Interfaces: Settings, OpenURI, FileChooser, Screenshot, ScreenCast (consent granted, consent denied,
emergency stop), Notification. Print is not used by WorkSuite (Electron prints through CUPS directly) and is not
tested.
"""
import asyncio
import json
import os
import subprocess
import sys
import time
import unittest
import uuid
from urllib.parse import unquote, urlparse

from dbus_next import BusType, Message, MessageType, Variant
from dbus_next.aio import MessageBus

DEST = 'org.freedesktop.portal.Desktop'
PATH = '/org/freedesktop/portal/desktop'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUN = os.environ.get('PORTAL_TEST_DIR', '/tmp')
STOP = os.path.join(ROOT, 'services/session/bin/worksuite-screencast-stop')


class Portal:
    def __init__(self, bus):
        self.bus = bus
        self.sender = bus.unique_name[1:].replace('.', '_')

    def token(self):
        return 'ws' + uuid.uuid4().hex[:12]

    async def call(self, iface, member, sig, body, path=PATH, dest=DEST):
        r = await self.bus.call(Message(destination=dest, path=path, interface=iface, member=member, signature=sig, body=body))
        if r.message_type == MessageType.ERROR:
            raise RuntimeError(f'{iface}.{member}: {r.error_name} {r.body}')
        return r.body

    async def request(self, iface, member, sig, args, options, timeout=20):
        """Call a method that answers through org.freedesktop.portal.Request::Response. Returns (code, results, path)."""
        tok = self.token()
        options = dict(options, handle_token=Variant('s', tok))
        handle = f'/org/freedesktop/portal/desktop/request/{self.sender}/{tok}'
        fut = asyncio.get_running_loop().create_future()

        def on(msg):
            if msg.message_type == MessageType.SIGNAL and msg.path == handle and msg.member == 'Response' and not fut.done():
                fut.set_result(msg.body)
        self.bus.add_message_handler(on)
        await self.match(f"type='signal',interface='org.freedesktop.portal.Request',member='Response',path='{handle}'")
        try:
            body = await self.call(iface, member, sig, [*args, options])
            assert body[0] == handle, body
            code, results = await asyncio.wait_for(fut, timeout)
            return code, results, handle
        finally:
            self.bus.remove_message_handler(on)

    async def pending(self, iface, member, sig, args, options, wait=2.0):
        """Start a request that needs the user (a dialog); returns (handle, response-or-None after `wait`)."""
        tok = self.token()
        options = dict(options, handle_token=Variant('s', tok))
        handle = f'/org/freedesktop/portal/desktop/request/{self.sender}/{tok}'
        got = []
        self.bus.add_message_handler(lambda m: got.append(m.body) if m.message_type == MessageType.SIGNAL and m.path == handle and m.member == 'Response' else None)
        await self.match(f"type='signal',interface='org.freedesktop.portal.Request',member='Response',path='{handle}'")
        body = await self.call(iface, member, sig, [*args, options])
        assert body[0] == handle
        await asyncio.sleep(wait)
        return handle, (got[0] if got else None)

    async def match(self, rule):
        await self.call('org.freedesktop.DBus', 'AddMatch', 's', [rule], path='/org/freedesktop/DBus', dest='org.freedesktop.DBus')

    async def version(self, iface):
        (v,) = await self.call('org.freedesktop.DBus.Properties', 'Get', 'ss', [iface, 'version'])
        return v.value


def read(path):
    if not os.path.exists(path):
        return ''
    with open(path) as f:
        return f.read()


def pw_nodes():
    out = subprocess.run(['pw-dump'], capture_output=True, text=True, timeout=10).stdout
    return {o['id']: o for o in json.loads(out or '[]') if o.get('type') == 'PipeWire:Interface:Node'}


def run(coro):
    return asyncio.run(coro)


class PortalAcceptance(unittest.TestCase):
    async def connect(self):
        bus = await MessageBus(bus_type=BusType.SESSION).connect()
        return bus, Portal(bus)

    # ---- Settings (gtk) ----
    def test_settings(self):
        async def go():
            bus, p = await self.connect()
            self.assertGreaterEqual(await p.version('org.freedesktop.portal.Settings'), 1)
            (all_,) = await p.call('org.freedesktop.portal.Settings', 'ReadAll', 'as', [['org.gnome.desktop.interface']])
            self.assertIn('org.gnome.desktop.interface', all_)
            self.assertIn('font-name', all_['org.gnome.desktop.interface'])
            (v,) = await p.call('org.freedesktop.portal.Settings', 'Read', 'ss', ['org.freedesktop.appearance', 'color-scheme'])
            inner = v.value.value if isinstance(v.value, Variant) else v.value
            self.assertIn(inner, (0, 1, 2))
            bus.disconnect()
        run(go())

    # ---- OpenURI (gtk app chooser, default handler without asking) ----
    def test_open_uri(self):
        out = os.path.join(RUN, 'opened-uri')
        if os.path.exists(out):
            os.remove(out)

        async def go():
            bus, p = await self.connect()
            code, _, _ = await p.request('org.freedesktop.portal.OpenURI', 'OpenURI', 'ssa{sv}', ['', 'x-worksuite-test://hello/world'],
                                         {'ask': Variant('b', False)})
            self.assertEqual(code, 0)
            bus.disconnect()
        run(go())
        for _ in range(50):
            if read(out).strip():
                break
            time.sleep(0.1)
        self.assertEqual(read(out).strip(), 'x-worksuite-test://hello/world')

    # ---- FileChooser (gtk dialog) ----
    def test_file_chooser(self):
        async def go():
            bus, p = await self.connect()
            self.assertGreaterEqual(await p.version('org.freedesktop.portal.FileChooser'), 1)
            # The GTK dialog is now open and waiting for the user: no error and no response yet.
            handle, resp = await p.pending('org.freedesktop.portal.FileChooser', 'OpenFile', 'ssa{sv}', ['', 'Open'],
                                           {'modal': Variant('b', False)}, wait=3.0)
            self.assertIsNone(resp, f'dialog answered without the user: {resp}')
            # Request.Close dismisses it, as an app does when the user cancels elsewhere.
            await p.call('org.freedesktop.portal.Request', 'Close', '', [], path=handle)
            bus.disconnect()
        run(go())

    # ---- Screenshot (wlr) ----
    def test_screenshot(self):
        async def go():
            bus, p = await self.connect()
            code, res, _ = await p.request('org.freedesktop.portal.Screenshot', 'Screenshot', 'sa{sv}', [''],
                                           {'interactive': Variant('b', False)})
            bus.disconnect()
            return code, res
        code, res = run(go())
        self.assertEqual(code, 0, res)
        path = unquote(urlparse(res['uri'].value).path)
        with open(path, 'rb') as f:
            self.assertEqual(f.read(8), b'\x89PNG\r\n\x1a\n')

    # ---- ScreenCast (wlr) with the consent chooser and the emergency stop ----
    async def screencast(self, p, consent, start=True):
        """CreateSession, SelectSources (the WorkSuite consent chooser runs here), then Start. Returns
        (session, stage, code, results) where stage is the step that answered last."""
        with open(os.path.join(RUN, 'consent'), 'w') as f:   # the zenity stub "picks" this output; empty = Deny
            f.write(consent)
        code, res, _ = await p.request('org.freedesktop.portal.ScreenCast', 'CreateSession', 'a{sv}', [],
                                       {'session_handle_token': Variant('s', p.token())})
        self.assertEqual(code, 0, res)
        session = res['session_handle'].value
        code, res, _ = await p.request('org.freedesktop.portal.ScreenCast', 'SelectSources', 'oa{sv}', [session],
                                       {'types': Variant('u', 1), 'multiple': Variant('b', False)})
        if code != 0 or not start:
            return session, 'select', code, res
        code, res, _ = await p.request('org.freedesktop.portal.ScreenCast', 'Start', 'osa{sv}', [session, ''], {}, timeout=30)
        return session, 'start', code, res

    def chooser_log(self):
        return read(os.path.join(RUN, 'chooser.log'))

    def test_screencast_consent_and_stop(self):
        """Granting consent selects the chosen output; after the emergency stop that session can no longer start."""
        async def go():
            bus, p = await self.connect()
            self.assertGreaterEqual(await p.version('org.freedesktop.portal.ScreenCast'), 1)
            asked = len(self.chooser_log())
            session, stage, code, res = await self.screencast(p, 'HEADLESS-1', start=False)
            self.assertEqual((stage, code), ('select', 0), res)
            self.assertIn('HEADLESS-1', self.chooser_log()[asked:], 'the consent chooser was shown with the outputs')
            out = subprocess.run(['sh', STOP], capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 0, out.stderr)
            await asyncio.sleep(0.5)
            # xdpw was restarted: the backend session is gone, so the consented session cannot start sharing.
            code, res, _ = await p.request('org.freedesktop.portal.ScreenCast', 'Start', 'osa{sv}', [session, ''], {}, timeout=30)
            self.assertNotEqual(code, 0, res)
            self.assertNotIn('streams', res)
            bus.disconnect()
        run(go())

    def test_screencast_denied(self):
        async def go():
            bus, p = await self.connect()
            asked = len(self.chooser_log())
            _, stage, code, res = await self.screencast(p, '')   # the user presses Deny in the chooser
            self.assertNotEqual(code, 0, 'denying consent must not start a stream')
            self.assertEqual(stage, 'select')
            self.assertNotIn('streams', res)
            self.assertIn('HEADLESS-1', self.chooser_log()[asked:], 'consent was asked, not assumed')
            bus.disconnect()
        run(go())

    def test_screencast_stream_and_stop(self):
        """Full path: a PipeWire stream runs after consent and the emergency stop tears it down."""
        async def go():
            bus, p = await self.connect()
            session, stage, code, res = await self.screencast(p, 'HEADLESS-1')
            if code != 0 and os.environ.get('PORTAL_NO_DMABUF') == '1':
                bus.disconnect()
                self.skipTest('xdg-desktop-portal-wlr 0.7 needs DMA-BUF screencopy; the compositor runs the pixman '
                              'renderer here (no DRM device)')
            self.assertEqual((stage, code), ('start', 0), res)
            streams = res['streams'].value
            self.assertEqual(len(streams), 1)
            node = streams[0][0]
            await asyncio.sleep(0.5)
            nodes = pw_nodes()
            self.assertIn(node, nodes, 'the shared stream is a PipeWire node')
            self.assertTrue(str(nodes[node]['info']['props'].get('node.name', '')).startswith('xdpw_stream'))
            out = subprocess.run(['sh', STOP], capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertGreaterEqual(int(out.stdout.strip()), 1)
            await asyncio.sleep(1.0)
            self.assertNotIn(node, pw_nodes())
            bus.disconnect()
        run(go())

    # ---- Notification (gtk → org.freedesktop.Notifications) ----
    def test_notification(self):
        log = os.path.join(RUN, 'notifications.log')

        async def go():
            bus, p = await self.connect()
            await p.call('org.freedesktop.portal.Notification', 'AddNotification', 'sa{sv}',
                         ['ws-test', {'title': Variant('s', 'WorkSuite portal test'), 'body': Variant('s', 'hello')}])
            bus.disconnect()
        run(go())
        for _ in range(50):
            if 'WorkSuite portal test' in read(log):
                break
            time.sleep(0.1)
        self.assertIn('WorkSuite portal test', read(log))


if __name__ == '__main__':
    import warnings
    warnings.simplefilter('ignore', ResourceWarning)   # dbus-next leaves sockets to the GC
    unittest.main(verbosity=2, argv=[sys.argv[0], *sys.argv[1:]])
