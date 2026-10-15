import unittest

from worksuite_bridge.access import AccessPolicy
from worksuite_bridge.model import ACTIVATED, FULLSCREEN, MAXIMIZED, MINIMIZED, NotFound, WindowRegistry, flags_from_states


class RegistryTest(unittest.TestCase):
    def test_handles_are_unique_and_never_reused(self):
        seq = iter(["a", "a", "b", "b", "c"])
        r = WindowRegistry(new_handle=lambda: next(seq))
        w1 = r.add("n1", "foot", "Terminal")
        r.remove("n1")
        w2 = r.add("n2", "firefox", "Web")
        self.assertEqual((w1.handle, w2.handle), ("a", "b"))
        with self.assertRaises(NotFound):
            r.get("a")  # stale handle after close (WSOS-SHL-003)

    def test_events(self):
        events = []
        r = WindowRegistry()
        r.listeners.append(lambda kind, w: events.append((kind, w.title)))
        r.add("n", "foot", "one")
        r.update("n", title="one")  # no change → no event
        r.update("n", title="two", flags=ACTIVATED)
        r.remove("n")
        r.remove("n")  # already gone: ignored
        self.assertEqual(events, [("added", "one"), ("changed", "two"), ("removed", "two")])

    def test_flags(self):
        self.assertEqual(flags_from_states([0, 1, 2, 3, 99]), MAXIMIZED | MINIMIZED | ACTIVATED | FULLSCREEN)
        self.assertEqual(flags_from_states([]), 0)


class AccessTest(unittest.TestCase):
    def policy(self, exes):
        return AccessPolicy(uid=1000, allowed=("/usr/lib/worksuite/shell/electron/electron",), exe_of=lambda pid: exes.get(pid))

    def test_only_shell_binary_of_same_user(self):
        p = self.policy({1: "/usr/lib/worksuite/shell/electron/electron", 2: "/usr/bin/python3"})
        self.assertTrue(p.permits(1000, 1))
        self.assertFalse(p.permits(1000, 2))   # other program
        self.assertFalse(p.permits(1001, 1))   # other user
        self.assertFalse(p.permits(1000, 3))   # process gone
        self.assertFalse(p.permits(None, 1))


if __name__ == "__main__":
    unittest.main()
