"""Polkit agent protocol and lockout bookkeeping (no GObject needed)."""
import os
import tempfile
import unittest

from worksuite_polkit_agent import proto


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class ProtoTests(unittest.TestCase):
    def test_parse_faillock(self):
        self.assertEqual(proto.parse_faillock(""), (5, 600))
        self.assertEqual(proto.parse_faillock("# x\ndir = /var/run/faillock\naudit\ndeny = 3\nunlock_time = 0\n"), (3, 0))
        self.assertEqual(proto.parse_faillock("deny=0\nunlock_time = 300 # five minutes"), (1, 300))

    def test_lockout_counts_down_then_locks_then_expires(self):
        c = Clock()
        lo = proto.Lockout(5, 300, clock=c)
        self.assertEqual(lo.state("alex")["remaining"], 5)
        for left in (4, 3, 2, 1):
            self.assertEqual(lo.failed("alex")["remaining"], left)
        st = lo.failed("alex")
        self.assertTrue(st["locked"])
        self.assertEqual(st["locked_until"], 1300 * 1000)
        c.t = 1299
        self.assertTrue(lo.state("alex")["locked"])
        c.t = 1300
        self.assertEqual(lo.state("alex"), {"remaining": 5, "locked_until": None, "locked": False, "deny": 5, "unlock_time": 300})

    def test_admin_reset_lock_and_pam_notice(self):
        lo = proto.Lockout(5, 0, clock=Clock())
        st = lo.failed("alex", pam_says_locked=True)
        self.assertTrue(st["locked"])
        self.assertIsNone(st["locked_until"])
        lo.succeeded("alex")
        self.assertFalse(lo.state("alex")["locked"])
        self.assertTrue(proto.pam_says_locked("The account is locked due to 5 failed logins."))
        self.assertFalse(proto.pam_says_locked("Password: "))

    def test_program_name_and_identity(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "42"))
            with open(os.path.join(d, "42", "comm"), "w") as f:
                f.write("electron\n")
            self.assertEqual(proto.program_name({"polkit.subject-pid": "42"}, d), "WorkSuite")
            self.assertIsNone(proto.program_name({"polkit.subject-pid": "43"}, d))
            self.assertIsNone(proto.program_name({}, d))
        ids = [(0, "root", "root"), (1000, "alex", "Alex Perera")]
        self.assertEqual(proto.pick_identity(ids, 1000), ids[1])
        self.assertEqual(proto.pick_identity(ids, 1001), ids[0])
        self.assertIsNone(proto.pick_identity([], 1000))

    def test_line_reader(self):
        r = proto.LineReader()
        self.assertEqual(r.feed(b'{"type":"respond","id":"a","pass'), [])
        self.assertEqual(r.feed(b'word":"x"}\nnot json\n[1]\n{"type":"cancel","id":"a"}\n'),
                         [{"type": "respond", "id": "a", "password": "x"}, {"type": "cancel", "id": "a"}])
        self.assertEqual(proto.encode({"type": "done", "id": "a"}), b'{"type":"done","id":"a"}\n')


if __name__ == "__main__":
    unittest.main()
