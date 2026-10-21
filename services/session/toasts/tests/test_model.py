"""Toast stack and protocol (run: cd services/session/toasts && python3 -m unittest discover -s tests -t .)."""
import unittest

from worksuite_toasts.model import MAX_SHOWN, Osd, Stack, Toast, parse


class ProtocolTest(unittest.TestCase):
    def test_lines(self):
        op, t = parse('{"op":"show","key":"app-12","title":"Firefox","body":"Download done","tone":"warn","icon":"firefox-esr"}')
        self.assertEqual(op, "show")
        self.assertEqual((t.key, t.title, t.body, t.tone, t.icon, t.sticky), ("app-12", "Firefox", "Download done", "warn", "firefox-esr", False))
        self.assertEqual(parse('{"op":"hide","key":"app-12"}'), ("hide", "app-12"))
        self.assertEqual(parse('{"op":"clear"}'), ("clear", None))

    def test_rejects_bad_input(self):
        for bad in ("", "nope", "[]", '{"op":"show"}', '{"op":"show","key":"a b"}', '{"op":"rm","key":"a"}', '{"op":"hide","key":"' + "x" * 65 + '"}'):
            self.assertIsNone(parse(bad), bad)
        _, t = parse('{"op":"show","key":"k","title":"' + "T" * 500 + '","tone":"pink","icon":"../../etc;rm"}')
        self.assertEqual((len(t.title), t.tone, t.icon), (200, "ok", ""))
        _, t = parse('{"op":"show","key":"k","icon":"/usr/share/icons/x.png","sticky":true}')
        self.assertEqual((t.icon, t.sticky, t.title), ("/usr/share/icons/x.png", True, " "))


class StackTest(unittest.TestCase):
    def test_newest_first_bounded_and_replaced(self):
        s = Stack()
        for i in range(MAX_SHOWN):
            self.assertEqual(s.show(Toast(f"k{i}", "t")), [])
        dropped = s.show(Toast("new", "t"))
        self.assertEqual([d.key for d in dropped], ["k0"])
        self.assertEqual([x.key for x in s.items], ["new", "k2", "k1"])
        s.show(Toast("k1", "again"))
        self.assertEqual([x.key for x in s.items], ["k1", "new", "k2"])
        self.assertTrue(s.hide("new"))
        self.assertFalse(s.hide("new"))
        self.assertEqual([x.key for x in s.clear()], ["k1", "k2"])
        self.assertEqual(s.items, [])


class TimingTest(unittest.TestCase):
    def test_toasts_stay_six_seconds(self):
        from worksuite_toasts.model import TIMEOUT_MS
        self.assertEqual(TIMEOUT_MS, 6000)


class OsdTest(unittest.TestCase):
    """#62: the Fn-key level indicator's protocol line."""

    def test_osd_lines(self):
        self.assertEqual(parse('{"op":"osd","kind":"volume","value":45,"muted":false}'), ("osd", Osd("volume", 45, False)))
        self.assertEqual(parse('{"op":"osd","kind":"mic","value":0,"muted":true}'), ("osd", Osd("mic", 0, True)))
        self.assertEqual(parse('{"op":"osd","kind":"brightness","value":180}'), ("osd", Osd("brightness", 100, False)))
        for bad in ('{"op":"osd","kind":"cpu","value":3}', '{"op":"osd","kind":"volume","value":"5"}', '{"op":"osd","kind":"volume","value":true}',
                    '{"op":"osd","kind":"volume"}'):
            self.assertIsNone(parse(bad), bad)
